import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { pageDocName, workspaceDocName } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import { invites, memberships, pages } from '../src/db/schema'
import { Client, startTestServer, type TestServer } from './helpers'

/**
 * PRD section 4.5 as an end-to-end test: for every endpoint, what each role
 * gets. A "world" is one workspace with an owner, an editor, a viewer, plus a
 * stranger who belongs to a different workspace.
 */

let server: TestServer
type Cast = { owner: Client; editor: Client; viewer: Client; outsider: Client; ids: Record<'owner' | 'editor' | 'viewer' | 'outsider', string>; outsiderWorkspace: string; outsiderPage: string }
let cast: Cast

before(async () => {
  server = await startTestServer()
  const owner = new Client(server)
  const editor = new Client(server)
  const viewer = new Client(server)
  const outsider = new Client(server)
  const accounts = {
    owner: await owner.signup('Olive Owner'),
    editor: await editor.signup('Eddie Editor'),
    viewer: await viewer.signup('Vera Viewer'),
    outsider: await outsider.signup('Otto Outsider'),
  }
  cast = {
    owner,
    editor,
    viewer,
    outsider,
    ids: { owner: accounts.owner.user.id, editor: accounts.editor.user.id, viewer: accounts.viewer.user.id, outsider: accounts.outsider.user.id },
    outsiderWorkspace: accounts.outsider.workspace.id,
    outsiderPage: accounts.outsider.welcomePageId,
  }
})
after(async () => {
  await server.close()
})

type World = { workspaceId: string; pageId: string; inviteId: string }

/** A brand-new workspace with the four people in their roles. The owner's old workspaces are deleted so the per-user cap never gets in the way. */
async function makeWorld(): Promise<World> {
  const created = await cast.owner.post('/api/workspaces', { name: 'World' })
  assert.equal(created.status, 201)
  const workspaceId = created.body.id as string
  await cast.owner.invite(workspaceId, cast.editor, 'editor')
  await cast.owner.invite(workspaceId, cast.viewer, 'viewer')
  const page = await cast.owner.createPage(workspaceId, 'A page')
  const invite = await cast.owner.post(`/api/workspaces/${workspaceId}/invites`, { role: 'viewer' })
  return { workspaceId, pageId: page.id, inviteId: invite.body.invite.id }
}

async function dropWorld(world: World) {
  await cast.owner.delete(`/api/workspaces/${world.workspaceId}`)
}

type Role = 'owner' | 'editor' | 'viewer' | 'outsider'
type Row = {
  name: string
  call: (who: Client, w: World) => Promise<{ status: number }>
  expect: Record<Role, number>
}

const ALL_THREE = { owner: 200, editor: 200, viewer: 200, outsider: 404 }
const OWNER_ONLY = { owner: 200, editor: 403, viewer: 403, outsider: 404 }
const WRITERS = { owner: 200, editor: 200, viewer: 403, outsider: 404 }

const ROWS: Row[] = [
  { name: 'read the workspace', call: (c, w) => c.get(`/api/workspaces/${w.workspaceId}`), expect: ALL_THREE },
  { name: 'list the members', call: (c, w) => c.get(`/api/workspaces/${w.workspaceId}/members`), expect: ALL_THREE },
  { name: 'list the pages', call: (c, w) => c.get(`/api/workspaces/${w.workspaceId}/pages`), expect: ALL_THREE },
  { name: 'get a sync token for a page', call: (c, w) => c.post('/api/sync-token', { doc: pageDocName(w.pageId) }), expect: ALL_THREE },
  { name: 'get a sync token for the workspace channel', call: (c, w) => c.post('/api/sync-token', { doc: workspaceDocName(w.workspaceId) }), expect: ALL_THREE },

  { name: 'create a page', call: (c, w) => c.post(`/api/workspaces/${w.workspaceId}/pages`, { title: 'New' }), expect: { owner: 201, editor: 201, viewer: 403, outsider: 404 } },
  { name: 'rename a page', call: (c, w) => c.patch(`/api/pages/${w.pageId}`, { title: 'Renamed' }), expect: WRITERS },
  { name: 'delete a page', call: (c, w) => c.delete(`/api/pages/${w.pageId}`), expect: { owner: 204, editor: 204, viewer: 403, outsider: 404 } },

  { name: 'rename the workspace', call: (c, w) => c.patch(`/api/workspaces/${w.workspaceId}`, { name: 'Renamed' }), expect: OWNER_ONLY },
  { name: 'list invite links', call: (c, w) => c.get(`/api/workspaces/${w.workspaceId}/invites`), expect: OWNER_ONLY },
  { name: 'create an invite link', call: (c, w) => c.post(`/api/workspaces/${w.workspaceId}/invites`, { role: 'editor' }), expect: { owner: 201, editor: 403, viewer: 403, outsider: 404 } },
  { name: 'revoke an invite link', call: (c, w) => c.delete(`/api/workspaces/${w.workspaceId}/invites/${w.inviteId}`), expect: { owner: 204, editor: 403, viewer: 403, outsider: 404 } },
  { name: 'change a role', call: (c, w) => c.patch(`/api/workspaces/${w.workspaceId}/members/${cast.ids.viewer}`, { role: 'editor' }), expect: OWNER_ONLY },
  { name: 'make someone an owner', call: (c, w) => c.patch(`/api/workspaces/${w.workspaceId}/members/${cast.ids.editor}`, { role: 'owner' }), expect: OWNER_ONLY },
  // For the viewer this is "leave the workspace", which anybody may do.
  { name: 'remove the viewer from the workspace', call: (c, w) => c.delete(`/api/workspaces/${w.workspaceId}/members/${cast.ids.viewer}`), expect: { owner: 204, editor: 403, viewer: 204, outsider: 404 } },
  { name: 'delete the workspace', call: (c, w) => c.delete(`/api/workspaces/${w.workspaceId}`), expect: { owner: 204, editor: 403, viewer: 403, outsider: 404 } },
]

describe('what each role may do (PRD 4.5)', () => {
  for (const row of ROWS) {
    for (const role of ['owner', 'editor', 'viewer', 'outsider'] as const) {
      it(`${role} ${row.expect[role] < 300 ? 'can' : 'cannot'} ${row.name} (${row.expect[role]})`, async () => {
        const world = await makeWorld()
        try {
          const reply = await row.call(cast[role], world)
          assert.equal(reply.status, row.expect[role], JSON.stringify((reply as { body?: unknown }).body))
        } finally {
          await dropWorld(world)
        }
      })
    }
  }

  it('lets a viewer or editor leave, but they cannot remove others', async () => {
    const world = await makeWorld()
    try {
      assert.equal((await cast.viewer.delete(`/api/workspaces/${world.workspaceId}/members/${cast.ids.viewer}`)).status, 204)
      assert.equal((await cast.viewer.get(`/api/workspaces/${world.workspaceId}`)).status, 404, 'gone from their view at once')
      assert.equal((await cast.editor.delete(`/api/workspaces/${world.workspaceId}/members/${cast.ids.owner}`)).status, 403)
      assert.equal((await cast.editor.delete(`/api/workspaces/${world.workspaceId}/members/${cast.ids.editor}`)).status, 204)
    } finally {
      await dropWorld(world)
    }
  })

  it('shows email addresses to owners only', async () => {
    const world = await makeWorld()
    try {
      const asOwner = (await cast.owner.get(`/api/workspaces/${world.workspaceId}/members`)).body.members
      const asViewer = (await cast.viewer.get(`/api/workspaces/${world.workspaceId}/members`)).body.members
      assert.equal(asOwner.length, 3)
      assert.ok(asOwner.every((member: { email?: string }) => typeof member.email === 'string'))
      assert.ok(asViewer.every((member: { email?: string }) => member.email === undefined), 'viewers do not see anyone\'s email')
      assert.ok(!JSON.stringify(asViewer).includes('@example.com'))
    } finally {
      await dropWorld(world)
    }
  })
})

describe('everything needs a session', () => {
  const some = randomUUID()
  const routes: [string, string, unknown][] = [
    ['GET', '/api/auth/me', undefined],
    ['PATCH', '/api/auth/me', { displayName: 'x' }],
    ['POST', '/api/workspaces', { name: 'x' }],
    ['GET', `/api/workspaces/${some}`, undefined],
    ['PATCH', `/api/workspaces/${some}`, { name: 'x' }],
    ['DELETE', `/api/workspaces/${some}`, undefined],
    ['GET', `/api/workspaces/${some}/members`, undefined],
    ['PATCH', `/api/workspaces/${some}/members/${some}`, { role: 'viewer' }],
    ['DELETE', `/api/workspaces/${some}/members/${some}`, undefined],
    ['GET', `/api/workspaces/${some}/invites`, undefined],
    ['POST', `/api/workspaces/${some}/invites`, { role: 'viewer' }],
    ['DELETE', `/api/workspaces/${some}/invites/${some}`, undefined],
    ['POST', '/api/invites/accept', { token: 'A'.repeat(43) }],
    ['GET', `/api/workspaces/${some}/pages`, undefined],
    ['POST', `/api/workspaces/${some}/pages`, { title: 'x' }],
    ['PATCH', `/api/pages/${some}`, { title: 'x' }],
    ['DELETE', `/api/pages/${some}`, undefined],
    ['POST', '/api/sync-token', { doc: `page.${some}` }],
  ]
  for (const [method, url, body] of routes) {
    it(`${method} ${url.replace(some, ':id').replace(some, ':id')} needs signing in`, async () => {
      const reply = await new Client(server).request(method, url, body)
      assert.equal(reply.status, 401)
      assert.equal(reply.body.error.code, 'unauthorized')
    })
  }

  it('the only open endpoints are sign-up, sign-in, sign-out, invite preview and health', async () => {
    const open = [
      new Client(server).post('/api/invites/preview', { token: 'A'.repeat(43) }),
      new Client(server).post('/api/auth/logout'),
      new Client(server).get('/api/health'),
    ]
    assert.deepEqual((await Promise.all(open)).map((reply) => reply.status), [404, 204, 200])
  })
})

describe('one workspace cannot reach into another', () => {
  it('answers 404 to a stranger for every read of someone else\'s workspace', async () => {
    const world = await makeWorld()
    try {
      const { outsider } = cast
      const urls = [
        `/api/workspaces/${world.workspaceId}`,
        `/api/workspaces/${world.workspaceId}/members`,
        `/api/workspaces/${world.workspaceId}/pages`,
        `/api/workspaces/${world.workspaceId}/invites`,
      ]
      for (const url of urls) assert.equal((await outsider.get(url)).status, 404, url)
      for (const doc of [pageDocName(world.pageId), workspaceDocName(world.workspaceId)]) {
        assert.equal((await outsider.post('/api/sync-token', { doc })).status, 404, doc)
      }
    } finally {
      await dropWorld(world)
    }
  })

  it('gives the same answer for "not yours" and "does not exist", so ids cannot be probed', async () => {
    const world = await makeWorld()
    try {
      const real = await cast.outsider.get(`/api/workspaces/${world.workspaceId}`)
      const fake = await cast.outsider.get(`/api/workspaces/${randomUUID()}`)
      assert.equal(real.status, 404)
      assert.deepEqual(real.body, fake.body)
      const realPage = await cast.outsider.patch(`/api/pages/${world.pageId}`, { title: 'x' })
      const fakePage = await cast.outsider.patch(`/api/pages/${randomUUID()}`, { title: 'x' })
      assert.equal(realPage.status, 404)
      assert.deepEqual(realPage.body, fakePage.body)
      const realToken = await cast.outsider.post('/api/sync-token', { doc: pageDocName(world.pageId) })
      const fakeToken = await cast.outsider.post('/api/sync-token', { doc: pageDocName(randomUUID()) })
      assert.equal(realToken.status, 404)
      assert.deepEqual(realToken.body, fakeToken.body)
    } finally {
      await dropWorld(world)
    }
  })

  it('does not let a stranger edit or delete someone else\'s page, and the page is untouched', async () => {
    const world = await makeWorld()
    try {
      assert.equal((await cast.outsider.patch(`/api/pages/${world.pageId}`, { title: 'Defaced' })).status, 404)
      assert.equal((await cast.outsider.delete(`/api/pages/${world.pageId}`)).status, 404)
      assert.equal((await cast.outsider.post(`/api/workspaces/${world.workspaceId}/pages`, { title: 'Planted' })).status, 404)
      const [row] = await server.db.select().from(pages).where(eq(pages.id, world.pageId))
      assert.equal(row.title, 'A page')
      assert.equal(row.deletedAt, null)
      assert.equal((await cast.owner.get(`/api/workspaces/${world.workspaceId}/pages`)).body.pages.length, 1)
    } finally {
      await dropWorld(world)
    }
  })

  it('does not let an owner of one workspace use that role on another workspace\'s ids', async () => {
    const world = await makeWorld()
    try {
      // The outsider owns their own workspace. They try ids from the other one inside THEIR URLs.
      const mine = cast.outsiderWorkspace
      const revokeForeignInvite = await cast.outsider.delete(`/api/workspaces/${mine}/invites/${world.inviteId}`)
      assert.equal(revokeForeignInvite.status, 404)
      const [stillThere] = await server.db.select().from(invites).where(eq(invites.id, world.inviteId))
      assert.equal(stillThere.revokedAt, null, 'the invite of the other workspace was not revoked')

      assert.equal((await cast.outsider.patch(`/api/workspaces/${mine}/members/${cast.ids.viewer}`, { role: 'owner' })).status, 404)
      assert.equal((await cast.outsider.delete(`/api/workspaces/${mine}/members/${cast.ids.viewer}`)).status, 404)
      const [role] = await server.db.select().from(memberships).where(eq(memberships.userId, cast.ids.viewer))
      assert.ok(role, 'the viewer is still a member of the other workspace')
      assert.equal((await cast.owner.get(`/api/workspaces/${world.workspaceId}/members`)).body.members.length, 3)
    } finally {
      await dropWorld(world)
    }
  })

  it('treats a malformed id as plain "not found"', async () => {
    const bad = ['not-a-uuid', '1', "1' or '1'='1", '00000000-0000-0000-0000-00000000000', `${randomUUID()}x`, randomUUID().toUpperCase().slice(0, 35), '%00']
    for (const id of bad) {
      for (const [method, url, body] of [
        ['GET', `/api/workspaces/${encodeURIComponent(id)}`, undefined],
        ['GET', `/api/workspaces/${encodeURIComponent(id)}/pages`, undefined],
        ['PATCH', `/api/pages/${encodeURIComponent(id)}`, { title: 'x' }],
        ['DELETE', `/api/pages/${encodeURIComponent(id)}`, undefined],
        ['PATCH', `/api/workspaces/${cast.outsiderWorkspace}/members/${encodeURIComponent(id)}`, { role: 'viewer' }],
      ] as const) {
        const reply = await cast.owner.request(method, url, body)
        assert.equal(reply.status, 404, `${method} ${url}`)
      }
    }
  })
})

describe('the server decides, not the request', () => {
  it('ignores any role, owner or workspace that a request body tries to supply', async () => {
    const world = await makeWorld()
    try {
      // strict bodies: extra fields are an error, never silently accepted
      assert.equal((await cast.viewer.post(`/api/workspaces/${world.workspaceId}/pages`, { title: 'x', role: 'owner' })).status, 400)
      assert.equal((await cast.editor.patch(`/api/pages/${world.pageId}`, { title: 'x', workspaceId: cast.outsiderWorkspace })).status, 400)
      assert.equal((await cast.editor.patch(`/api/workspaces/${world.workspaceId}`, { name: 'x', role: 'owner' })).status, 400)
      assert.equal((await cast.owner.post(`/api/workspaces`, { name: 'x', createdBy: cast.ids.viewer })).status, 400)
      assert.equal((await cast.owner.patch(`/api/workspaces/${world.workspaceId}/members/${cast.ids.viewer}`, { role: 'editor', userId: cast.ids.owner })).status, 400)
    } finally {
      await dropWorld(world)
    }
  })

  it('does not let a request move a page into another workspace', async () => {
    const world = await makeWorld()
    try {
      assert.equal((await cast.owner.patch(`/api/pages/${world.pageId}`, { title: 'x', workspaceId: cast.outsiderWorkspace })).status, 400)
      const [row] = await server.db.select().from(pages).where(eq(pages.id, world.pageId))
      assert.equal(row.workspaceId, world.workspaceId)
    } finally {
      await dropWorld(world)
    }
  })

  it('reads the role from the database on every request: a demoted editor is read-only immediately', async () => {
    const world = await makeWorld()
    try {
      assert.equal((await cast.editor.patch(`/api/pages/${world.pageId}`, { title: 'ok' })).status, 200)
      assert.equal((await cast.owner.patch(`/api/workspaces/${world.workspaceId}/members/${cast.ids.editor}`, { role: 'viewer' })).status, 200)
      assert.equal((await cast.editor.patch(`/api/pages/${world.pageId}`, { title: 'now blocked' })).status, 403)
      assert.equal((await cast.owner.patch(`/api/workspaces/${world.workspaceId}/members/${cast.ids.editor}`, { role: 'editor' })).status, 200)
      assert.equal((await cast.editor.patch(`/api/pages/${world.pageId}`, { title: 'fine again' })).status, 200)
    } finally {
      await dropWorld(world)
    }
  })

  it('cannot reach a page that was deleted, even as its owner', async () => {
    const world = await makeWorld()
    try {
      assert.equal((await cast.owner.delete(`/api/pages/${world.pageId}`)).status, 204)
      assert.equal((await cast.owner.patch(`/api/pages/${world.pageId}`, { title: 'zombie' })).status, 404)
      assert.equal((await cast.owner.delete(`/api/pages/${world.pageId}`)).status, 404)
      assert.equal((await cast.owner.post('/api/sync-token', { doc: pageDocName(world.pageId) })).status, 404)
      assert.equal((await cast.owner.get(`/api/workspaces/${world.workspaceId}/pages`)).body.pages.length, 0)
    } finally {
      await dropWorld(world)
    }
  })
})
