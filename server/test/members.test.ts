import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { LIMITS } from '@conflux/shared'
import { and, eq } from 'drizzle-orm'
import { invites, memberships, pageDocs, pages, workspaces } from '../src/db/schema'
import { Client, startTestServer, type TestServer } from './helpers'

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})

type Person = { client: Client; id: string }

async function person(name: string): Promise<Person & { ws: string }> {
  const client = new Client(server)
  const account = await client.signup(name)
  return { client, id: account.user.id, ws: account.workspace.id }
}

/** An owner, with `roles` people added in those roles. */
async function workspaceWith(...roles: ('owner' | 'editor' | 'viewer')[]) {
  const owner = await person('Owner')
  const members: (Person & { ws: string })[] = []
  for (const [i, role] of roles.entries()) {
    const member = await person(`${role} ${i}`)
    await owner.client.invite(owner.ws, member.client, role === 'owner' ? 'editor' : role)
    if (role === 'owner') await owner.client.patch(`/api/workspaces/${owner.ws}/members/${member.id}`, { role: 'owner' })
    members.push(member)
  }
  const owners = async () => (await server.db.select().from(memberships).where(and(eq(memberships.workspaceId, owner.ws), eq(memberships.role, 'owner')))).length
  return { owner, members, ws: owner.ws, owners }
}

describe('workspaces', () => {
  it('can be created, and the creator becomes its only owner', async () => {
    const { client, id } = await person('Maker')
    const reply = await client.post('/api/workspaces', { name: '  Side   project ' })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.name, 'Side project')
    assert.equal(reply.body.role, 'owner')
    const rows = await server.db.select().from(memberships).where(eq(memberships.workspaceId, reply.body.id))
    assert.deepEqual(rows.map((row) => [row.userId, row.role]), [[id, 'owner']])
  })

  it('validates names', async () => {
    const { client } = await person('Namer')
    for (const name of ['', '   ', 'x'.repeat(LIMITS.workspaceNameMax + 1), 'bad\u0000name', 'rtl‮trick', 5, null]) {
      assert.equal((await client.post('/api/workspaces', { name })).status, 400, JSON.stringify(name))
    }
  })

  it('limits how many a person can own, and deleting one frees a slot', async () => {
    const { client } = await person('Collector')
    const made: string[] = []
    for (let i = 1; i < LIMITS.maxOwnedWorkspaces; i++) {
      const reply = await client.post('/api/workspaces', { name: `W${i}` })
      assert.equal(reply.status, 201)
      made.push(reply.body.id)
    }
    const over = await client.post('/api/workspaces', { name: 'One too many' })
    assert.equal(over.status, 403)
    assert.equal(over.body.error.code, 'quota_exceeded')
    assert.equal((await client.delete(`/api/workspaces/${made[0]}`)).status, 204)
    assert.equal((await client.post('/api/workspaces', { name: 'Again' })).status, 201)
  })

  it('does not count workspaces where you are only a guest towards your limit', async () => {
    const host = await workspaceWith('editor')
    const guest = host.members[0]
    for (let i = 1; i < LIMITS.maxOwnedWorkspaces; i++) assert.equal((await guest.client.post('/api/workspaces', { name: `G${i}` })).status, 201)
    const mine = (await guest.client.get('/api/auth/me')).body.workspaces
    assert.equal(mine.length, LIMITS.maxOwnedWorkspaces + 1)
  })

  it('is renamed by the owner, and the new name is cleaned the same way', async () => {
    const { owner, ws } = await workspaceWith()
    const reply = await owner.client.patch(`/api/workspaces/${ws}`, { name: '  New   name ' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.name, 'New name')
    assert.equal((await owner.client.patch(`/api/workspaces/${ws}`, { name: '' })).status, 400)
  })

  it('is deleted with everything in it, and members find it gone at once', async () => {
    const { owner, members, ws } = await workspaceWith('editor', 'viewer')
    const page = await owner.client.createPage(ws, 'Doomed')
    await server.db.insert(pageDocs).values({ pageId: page.id, state: new Uint8Array([1, 2, 3]) })
    await owner.client.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' })

    assert.equal((await owner.client.delete(`/api/workspaces/${ws}`)).status, 204)
    for (const member of members) assert.equal((await member.client.get(`/api/workspaces/${ws}`)).status, 404)
    assert.equal((await owner.client.get(`/api/workspaces/${ws}/pages`)).status, 404)
    assert.equal((await server.db.select().from(workspaces).where(eq(workspaces.id, ws))).length, 0)
    assert.equal((await server.db.select().from(memberships).where(eq(memberships.workspaceId, ws))).length, 0)
    assert.equal((await server.db.select().from(pages).where(eq(pages.workspaceId, ws))).length, 0)
    assert.equal((await server.db.select().from(pageDocs).where(eq(pageDocs.pageId, page.id))).length, 0)
    assert.equal((await server.db.select().from(invites).where(eq(invites.workspaceId, ws))).length, 0)
  })

  it('shows each person their own role in every workspace', async () => {
    const a = await workspaceWith('editor')
    const b = await workspaceWith()
    const guest = a.members[0]
    await b.owner.client.invite(b.ws, guest.client, 'viewer')
    const mine = (await guest.client.get('/api/auth/me')).body.workspaces as { id: string; role: string }[]
    assert.equal(mine.find((workspace) => workspace.id === guest.ws)?.role, 'owner', 'their own')
    assert.equal(mine.find((workspace) => workspace.id === a.ws)?.role, 'editor')
    assert.equal(mine.find((workspace) => workspace.id === b.ws)?.role, 'viewer')
  })
})

describe('changing roles', () => {
  it('works in every direction, and the member\'s access changes with it', async () => {
    const { owner, members, ws } = await workspaceWith('viewer')
    const target = members[0]
    const setRole = (role: string) => owner.client.patch(`/api/workspaces/${ws}/members/${target.id}`, { role })
    const canCreate = async () => (await target.client.post(`/api/workspaces/${ws}/pages`, { title: 'try' })).status

    assert.equal(await canCreate(), 403)
    assert.equal((await setRole('editor')).status, 200)
    assert.equal(await canCreate(), 201)
    assert.equal((await setRole('viewer')).status, 200)
    assert.equal(await canCreate(), 403)
    assert.equal((await setRole('owner')).status, 200)
    assert.equal((await target.client.patch(`/api/workspaces/${ws}`, { name: 'Now I own it' })).status, 200)
  })

  it('answers 404 for someone who is not a member, 400 for a role that does not exist', async () => {
    const { owner, ws } = await workspaceWith('viewer')
    const stranger = await person('Stranger')
    assert.equal((await owner.client.patch(`/api/workspaces/${ws}/members/${stranger.id}`, { role: 'viewer' })).status, 404)
    const [member] = (await owner.client.get(`/api/workspaces/${ws}/members`)).body.members.filter((entry: { role: string }) => entry.role === 'viewer')
    for (const role of ['admin', 'OWNER', '', null, 1]) assert.equal((await owner.client.patch(`/api/workspaces/${ws}/members/${member.userId}`, { role })).status, 400, String(role))
  })
})

describe('the last owner', () => {
  it('cannot demote themselves or leave while they are the only owner', async () => {
    const { owner, ws } = await workspaceWith('editor')
    const demote = await owner.client.patch(`/api/workspaces/${ws}/members/${owner.id}`, { role: 'editor' })
    assert.equal(demote.status, 409)
    assert.equal(demote.body.error.code, 'last_owner')
    const leave = await owner.client.delete(`/api/workspaces/${ws}/members/${owner.id}`)
    assert.equal(leave.status, 409)
    assert.equal(leave.body.error.code, 'last_owner')
    assert.equal((await owner.client.get(`/api/workspaces/${ws}`)).body.role, 'owner')
  })

  it('may step down once someone else is an owner, and is then protected again', async () => {
    const { owner, members, ws, owners } = await workspaceWith('owner')
    assert.equal(await owners(), 2)
    assert.equal((await owner.client.patch(`/api/workspaces/${ws}/members/${owner.id}`, { role: 'editor' })).status, 200)
    assert.equal(await owners(), 1)
    const successor = members[0]
    assert.equal((await successor.client.delete(`/api/workspaces/${ws}/members/${successor.id}`)).status, 409)
    assert.equal((await successor.client.patch(`/api/workspaces/${ws}/members/${successor.id}`, { role: 'viewer' })).status, 409)
    assert.equal(await owners(), 1)
  })

  it('can leave when another owner exists', async () => {
    const { owner, ws, owners } = await workspaceWith('owner')
    assert.equal((await owner.client.delete(`/api/workspaces/${ws}/members/${owner.id}`)).status, 204)
    assert.equal(await owners(), 1)
  })

  it('cannot be removed by an editor, whoever is asking', async () => {
    const { members, owner, ws } = await workspaceWith('editor')
    assert.equal((await members[0].client.delete(`/api/workspaces/${ws}/members/${owner.id}`)).status, 403)
    assert.equal((await members[0].client.patch(`/api/workspaces/${ws}/members/${owner.id}`, { role: 'viewer' })).status, 403)
  })

  it('survives two owners demoting each other at the same instant', async () => {
    for (let round = 0; round < 3; round++) {
      const { owner, members, ws, owners } = await workspaceWith('owner')
      const other = members[0]
      const replies = await Promise.all([
        owner.client.patch(`/api/workspaces/${ws}/members/${other.id}`, { role: 'viewer' }),
        other.client.patch(`/api/workspaces/${ws}/members/${owner.id}`, { role: 'viewer' }),
      ])
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 403], `round ${round}`)
      assert.equal(await owners(), 1, `round ${round}: there is always one owner left`)
    }
  })

  it('survives two owners leaving at the same instant', async () => {
    for (let round = 0; round < 3; round++) {
      const { owner, members, ws, owners } = await workspaceWith('owner')
      const other = members[0]
      const replies = await Promise.all([
        owner.client.delete(`/api/workspaces/${ws}/members/${owner.id}`),
        other.client.delete(`/api/workspaces/${ws}/members/${other.id}`),
      ])
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [204, 409], `round ${round}`)
      assert.equal(await owners(), 1, `round ${round}`)
    }
  })

  it('survives an owner being removed by the other owner while also stepping down', async () => {
    const { owner, members, ws, owners } = await workspaceWith('owner')
    const other = members[0]
    const replies = await Promise.all([
      owner.client.delete(`/api/workspaces/${ws}/members/${other.id}`),
      other.client.patch(`/api/workspaces/${ws}/members/${other.id}`, { role: 'editor' }),
    ])
    assert.ok(replies.some((reply) => reply.status < 300))
    assert.equal(await owners(), 1)
  })
})

describe('removing and leaving', () => {
  it('lets the owner remove a member, who then loses access immediately', async () => {
    const { owner, members, ws } = await workspaceWith('editor')
    const target = members[0]
    assert.equal((await target.client.get(`/api/workspaces/${ws}/pages`)).status, 200)
    assert.equal((await owner.client.delete(`/api/workspaces/${ws}/members/${target.id}`)).status, 204)
    for (const url of [`/api/workspaces/${ws}`, `/api/workspaces/${ws}/pages`, `/api/workspaces/${ws}/members`]) assert.equal((await target.client.get(url)).status, 404, url)
    assert.equal((await target.client.post(`/api/workspaces/${ws}/pages`, { title: 'still here?' })).status, 404)
    assert.ok(!(await target.client.get('/api/auth/me')).body.workspaces.some((workspace: { id: string }) => workspace.id === ws))
  })

  it('answers 404 when the target is not a member', async () => {
    const { owner, ws } = await workspaceWith()
    const stranger = await person('Stranger')
    assert.equal((await owner.client.delete(`/api/workspaces/${ws}/members/${stranger.id}`)).status, 404)
  })

  it('keeps what a removed member wrote, but not their access', async () => {
    const { owner, members, ws } = await workspaceWith('editor')
    const page = await members[0].client.createPage(ws, 'By the editor')
    await owner.client.delete(`/api/workspaces/${ws}/members/${members[0].id}`)
    const listed = (await owner.client.get(`/api/workspaces/${ws}/pages`)).body.pages
    assert.ok(listed.some((entry: { id: string }) => entry.id === page.id))
  })

  it('removes the person, not the account: they keep their own workspace', async () => {
    const { owner, members, ws } = await workspaceWith('viewer')
    await owner.client.delete(`/api/workspaces/${ws}/members/${members[0].id}`)
    assert.equal((await members[0].client.get(`/api/workspaces/${members[0].ws}`)).status, 200)
  })
})
