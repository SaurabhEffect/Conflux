import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { workspaceDocName } from '@conflux/shared'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  Client,
  RawClient,
  makeTeam,
  makeUpdate,
  openDoc,
  savedText,
  settle,
  startTestServer,
  textOf,
  typeInto,
  untilUnloaded,
  waitFor,
  type Peer,
  type Team,
  type TestServer,
} from './helpers'

/**
 * PRD exit criterion: viewers cannot change anything, and strangers cannot
 * read. These tests connect real clients to the real server over real
 * WebSockets, and then look at what the server did with their edits.
 */

let server: TestServer
let team: Team
const peers: Peer[] = []
const raws: RawClient[] = []

const open = (client: Client, doc = team.doc) => {
  const peer = openDoc(server, client, doc)
  peers.push(peer)
  return peer
}
const openRaw = async (client: Client, doc = team.doc) => {
  const raw = new RawClient(server.wsUrl, doc)
  raws.push(raw)
  const token = (await client.post('/api/sync-token', { doc })).body.token as string
  const verdict = await raw.authenticate(token)
  return { raw, verdict }
}

before(async () => {
  server = await startTestServer()
  team = await makeTeam(server)
})
after(async () => {
  await server.close()
})
// Each test gets a fresh page so the tests cannot affect each other.
let counter = 0
const freshPage = async (title = `Page ${++counter}`) => {
  const page = await team.owner.createPage(team.ws, title)
  return { id: page.id, doc: `page.${page.id}` }
}
const cleanup = () => {
  for (const peer of peers.splice(0)) peer.destroy()
  for (const raw of raws.splice(0)) raw.close()
}
// Even a failing test must let go of its sockets, or the whole run hangs.
afterEach(cleanup)

describe('who can write to a page', () => {
  it('an editor\'s typing reaches the owner live, and is saved', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    await Promise.all([owner.synced, editor.synced])
    assert.equal(owner.isReadOnly(), false)
    assert.equal(editor.isReadOnly(), false)

    typeInto(editor, 'hello from the editor')
    await waitFor(() => textOf(owner) === 'hello from the editor', 3000, 'the owner to see the edit')
    typeInto(owner, 'owner says: ')
    await waitFor(() => textOf(editor) === 'owner says: hello from the editor', 3000, 'the editor to see the reply')

    cleanup()
    await untilUnloaded(server)
    assert.equal(await savedText(server.db, page.id), 'owner says: hello from the editor')
    cleanup()
  })

  it('a viewer connects read-only and still sees everyone\'s edits live', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const viewer = open(team.viewer, page.doc)
    await Promise.all([owner.synced, viewer.synced])
    assert.equal(viewer.isReadOnly(), true, 'the server told the viewer they are read-only')
    typeInto(owner, 'live update')
    await waitFor(() => textOf(viewer) === 'live update', 3000, 'the viewer to see the edit')
    cleanup()
  })

  it('a viewer\'s edits are not applied, not shown to others, and not saved', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    const viewer = open(team.viewer, page.doc)
    await Promise.all([owner.synced, editor.synced, viewer.synced])

    typeInto(owner, 'the real content')
    await waitFor(() => textOf(viewer) === 'the real content')
    // The viewer's browser has been tampered with: it edits anyway.
    typeInto(viewer, 'DEFACED ')
    viewer.doc.getText('t').insert(5, ' and more ')
    await settle(1500)

    assert.equal(textOf(owner), 'the real content', 'the owner never saw it')
    assert.equal(textOf(editor), 'the real content', 'the editor never saw it')

    // A brand-new visitor loads the server's copy: it is clean.
    const later = open(team.editor, page.doc)
    await later.synced
    assert.equal(textOf(later), 'the real content')

    cleanup()
    await untilUnloaded(server)
    assert.equal(await savedText(server.db, page.id), 'the real content', 'nothing the viewer typed was written to the database')
    cleanup()
  })

  it('a viewer who keeps editing while others type changes nothing for anyone', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const viewer = open(team.viewer, page.doc)
    await Promise.all([owner.synced, viewer.synced])
    for (let i = 0; i < 20; i++) {
      typeInto(viewer, `vandalism ${i} `)
      typeInto(owner, `owner ${i} `)
      await settle(15)
    }
    await waitFor(() => !textOf(owner).includes('vandalism') && textOf(owner).includes('owner 19'), 3000)
    assert.ok(!textOf(owner).includes('vandalism'))
    cleanup()
    await untilUnloaded(server)
    const saved = (await savedText(server.db, page.id)) ?? ''
    assert.ok(saved.includes('owner 19'))
    assert.ok(!saved.includes('vandalism'))
    cleanup()
  })

  it('refuses a hand-made edit from a viewer, and says so', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    await owner.synced
    typeInto(owner, 'original')

    const { raw, verdict } = await openRaw(team.viewer, page.doc)
    assert.deepEqual(verdict, { kind: 'authenticated', scope: 'readonly' })

    const mark = raw.received.length
    raw.sendUpdate(makeUpdate('EVIL EDIT'))
    const answer = await raw.next('syncStatus', mark)
    assert.equal(answer.saved, false, 'the server answered "not applied"')

    // The other way a client can deliver changes: as part of the initial exchange.
    const mark2 = raw.received.length
    raw.sendSyncStep2(makeUpdate('MORE EVIL'))
    assert.equal((await raw.next('syncStatus', mark2)).saved, false)

    await settle(500)
    assert.equal(textOf(owner), 'original')
    cleanup()
    await untilUnloaded(server)
    assert.equal(await savedText(server.db, page.id), 'original')
    cleanup()
  })

  it('and the very same hand-made message IS accepted from an editor (so the test above proves something)', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    await owner.synced
    const { raw, verdict } = await openRaw(team.editor, page.doc)
    assert.deepEqual(verdict, { kind: 'authenticated', scope: 'read-write' })
    const mark = raw.received.length
    raw.sendUpdate(makeUpdate('from a raw editor'))
    assert.equal((await raw.next('syncStatus', mark)).saved, true)
    await waitFor(() => textOf(owner) === 'from a raw editor', 3000, 'the owner to see it')
    cleanup()
  })

  it('does not accept a role claimed by the client: the scope comes from the database', async () => {
    const page = await freshPage()
    const { verdict } = await openRaw(team.viewer, page.doc)
    assert.deepEqual(verdict, { kind: 'authenticated', scope: 'readonly' })
    cleanup()
  })
})

describe('the workspace channel (page list notifications)', () => {
  it('is read-only for everyone, including the owner', async () => {
    const doc = workspaceDocName(team.ws)
    const owner = open(team.owner, doc)
    const editor = open(team.editor, doc)
    await Promise.all([owner.synced, editor.synced])
    assert.equal(owner.isReadOnly(), true)
    assert.equal(editor.isReadOnly(), true)
    typeInto(owner, 'owner scribbles on the channel')
    await settle(600)
    assert.equal(textOf(editor), '')
    cleanup()
  })

  it('tells members when pages are created, renamed or deleted, and members when people join', async () => {
    const doc = workspaceDocName(team.ws)
    const editor = open(team.editor, doc)
    const viewer = open(team.viewer, doc)
    await Promise.all([editor.synced, viewer.synced])
    const heard = (peer: Peer) => {
      const events: string[] = []
      peer.provider.on('stateless', ({ payload }: { payload: string }) => events.push(JSON.parse(payload).type))
      return events
    }
    const editorEvents = heard(editor)
    const viewerEvents = heard(viewer)

    const page = await team.owner.createPage(team.ws, 'Announced')
    await waitFor(() => viewerEvents.includes('pages') && editorEvents.includes('pages'), 3000, 'both to hear about the new page')
    const before = viewerEvents.length
    await team.owner.patch(`/api/pages/${page.id}`, { title: 'Renamed' })
    await waitFor(() => viewerEvents.length > before, 3000, 'a rename notification')
    const before2 = viewerEvents.length
    await team.owner.delete(`/api/pages/${page.id}`)
    await waitFor(() => viewerEvents.length > before2, 3000, 'a delete notification')

    const join = new Client(server)
    await join.signup('New Person')
    await team.owner.invite(team.ws, join, 'viewer')
    await waitFor(() => viewerEvents.includes('members'), 3000, 'a members notification')
    cleanup()
  })

  it('carries nothing but the event type: no titles, names or ids', async () => {
    const doc = workspaceDocName(team.ws)
    const viewer = open(team.viewer, doc)
    await viewer.synced
    const payloads: string[] = []
    viewer.provider.on('stateless', ({ payload }: { payload: string }) => payloads.push(payload))
    await team.owner.createPage(team.ws, 'Secret roadmap')
    await waitFor(() => payloads.length > 0)
    for (const payload of payloads) {
      assert.ok(!payload.includes('Secret roadmap'))
      assert.deepEqual(Object.keys(JSON.parse(payload)), ['type'])
    }
    cleanup()
  })

  it('does not reach people in other workspaces', async () => {
    const stranger = new Client(server)
    const account = await stranger.signup('Stranger')
    const own = open(stranger, workspaceDocName(account.workspace.id))
    await own.synced
    const heard: string[] = []
    own.provider.on('stateless', ({ payload }: { payload: string }) => heard.push(payload))
    await team.owner.createPage(team.ws, 'Not for you')
    await settle(600)
    assert.deepEqual(heard, [])
    cleanup()
  })
})

describe('presence (names and cursors)', () => {
  const stateOf = (peer: Peer, clientId: number) => peer.provider.awareness?.getStates().get(clientId) as { user?: { name?: string; color?: string }; cursor?: unknown } | undefined
  /** A place in the page's text, written the way the editor writes it. */
  const place = (clock: number) => ({ type: null, tname: 'content', item: { client: 4242, clock }, assoc: 0 })
  const cursorAt = (from: number, to = from) => ({ anchor: place(from), head: place(to) })
  const showsCursor = (peer: Peer, clientId: number, expected: unknown) => isDeepStrictEqual(stateOf(peer, clientId)?.cursor, expected)

  it('shows the real name and colour from the account, whatever the browser claims', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    await Promise.all([owner.synced, editor.synced])
    const ownerId = owner.provider.awareness!.clientID

    owner.provider.setAwarenessField('user', { name: 'ADMIN (verified)', color: '#ff0000' })
    owner.provider.setAwarenessField('cursor', cursorAt(1, 3))
    await waitFor(() => stateOf(editor, ownerId)?.cursor !== undefined, 3000, 'the cursor to arrive')
    const seen = stateOf(editor, ownerId)!
    assert.equal(seen.user?.name, 'Olive Owner', 'the server replaced the claimed name')
    assert.notEqual(seen.user?.color, '#ff0000')
    assert.deepEqual(seen.cursor, cursorAt(1, 3))
    cleanup()
  })

  it('drops extra fields and oversized cursors', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    await Promise.all([owner.synced, editor.synced])
    const ownerId = owner.provider.awareness!.clientID
    owner.provider.setAwarenessField('cursor', { ...cursorAt(1), junk: 'x'.repeat(5000) })
    owner.provider.setAwarenessField('script', '<img src=x onerror=alert(1)>')
    owner.provider.setAwarenessField('cursor', cursorAt(2))
    await waitFor(() => showsCursor(editor, ownerId, cursorAt(2)), 3000)
    assert.deepEqual(Object.keys(stateOf(editor, ownerId)!).sort(), ['cursor', 'user'])
    cleanup()
  })

  it('does not let one person move or hide another person\'s cursor', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const viewer = open(team.viewer, page.doc)
    await Promise.all([owner.synced, viewer.synced])
    const ownerId = owner.provider.awareness!.clientID
    owner.provider.setAwarenessField('cursor', cursorAt(7))
    await waitFor(() => stateOf(viewer, ownerId)?.cursor !== undefined, 3000)

    // The editor, who can see the owner's client id like everybody else, forges updates in the owner's name.
    const { raw } = await openRaw(team.editor, page.doc)
    const forgery = new awarenessProtocol.Awareness(new Y.Doc())
    forgery.doc.clientID = ownerId
    forgery.clientID = ownerId
    for (let i = 0; i < 50; i++) forgery.setLocalState({ user: { name: 'Mallory' }, cursor: cursorAt(999) })
    raw.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(forgery, [ownerId]))
    // ...and tries to "remove" the owner from the room.
    forgery.setLocalState(null)
    raw.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(forgery, [ownerId]))
    forgery.destroy() // (it starts a timer of its own)
    await settle(600)

    const seen = stateOf(viewer, ownerId)
    assert.ok(seen, 'the owner is still shown')
    assert.deepEqual(seen.cursor, cursorAt(7))
    assert.equal(seen.user?.name, 'Olive Owner')

    // The owner keeps working normally: the forged clock did not lock them out.
    owner.provider.setAwarenessField('cursor', cursorAt(8))
    await waitFor(() => showsCursor(viewer, ownerId, cursorAt(8)), 3000, 'the owner\'s next move')
    cleanup()
  })

  it('does accept a person\'s own presence from a hand-made message (control for the forgery test)', async () => {
    const page = await freshPage()
    const viewer = open(team.viewer, page.doc)
    await viewer.synced
    const { raw } = await openRaw(team.editor, page.doc)
    const own = new awarenessProtocol.Awareness(new Y.Doc())
    own.setLocalState({ user: { name: 'Anything' }, cursor: cursorAt(4) })
    raw.sendAwareness(awarenessProtocol.encodeAwarenessUpdate(own, [own.clientID]))
    own.destroy()
    await waitFor(() => stateOf(viewer, own.clientID)?.cursor !== undefined, 3000, 'the raw client\'s own cursor')
    assert.equal(stateOf(viewer, own.clientID)?.user?.name, 'Eddie Editor')
    cleanup()
  })

  it('drops a cursor that is not shaped like the ones the editor writes, so nobody else\'s editor can be made to fail', async () => {
    // Other people's editors read these and draw them. A viewer, the lowest role, can send anything at all.
    const page = await freshPage()
    const viewer = open(team.viewer, page.doc)
    const owner = open(team.owner, page.doc)
    await Promise.all([viewer.synced, owner.synced])
    const viewerId = viewer.provider.awareness!.clientID
    const hostile: [string, unknown][] = [
      ['empty parts', { anchor: null, head: null }],
      ['nothing in it', {}],
      ['a list', []],
      ['a string', 'x'],
      ['a number', 5],
      ['numbers instead of places', { anchor: 5, head: 'x' }],
      ['a place that points at nothing', { anchor: { type: null, tname: null, item: null, assoc: 0 }, head: place(1) }],
      ['ids that are not numbers', { anchor: { type: { client: 'a', clock: 'b' } }, head: place(1) }],
      ['a negative id', { anchor: { item: { client: -1, clock: 0 } }, head: place(1) }],
      ['a fractional id', { anchor: { item: { client: 1.5, clock: 0 } }, head: place(1) }],
      ['an id too big to be exact', { anchor: { item: { client: 1, clock: 2 ** 60 } }, head: place(1) }],
      ['a made-up text name', { anchor: { ...place(1), tname: 'secrets' }, head: place(1) }],
      ['an odd association', { anchor: { ...place(1), assoc: 99 }, head: place(1) }],
      ['an extra field on a place', { anchor: { ...place(1), extra: true }, head: place(1) }],
      ['an extra field on an id', { anchor: { item: { client: 1, clock: 1, extra: 1 } }, head: place(1) }],
      ['only half of it', { anchor: place(1) }],
      ['extra fields', { ...cursorAt(1), extra: 'x' }],
    ]
    for (const [label, cursor] of hostile) {
      viewer.provider.setAwarenessField('cursor', cursorAt(1))
      await waitFor(() => showsCursor(owner, viewerId, cursorAt(1)), 3000, `the good cursor before "${label}"`)
      viewer.provider.setAwarenessField('cursor', cursor)
      await waitFor(() => stateOf(owner, viewerId)?.cursor === undefined, 3000, `"${label}" to be dropped`)
      assert.equal(stateOf(owner, viewerId)?.user?.name, 'Vera Viewer', `${label}: still shown, only without a cursor`)
    }
    cleanup()
  })

  it('lets a cursor be cleared, and takes a normal one afterwards', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    await Promise.all([owner.synced, editor.synced])
    const ownerId = owner.provider.awareness!.clientID
    owner.provider.setAwarenessField('cursor', cursorAt(3))
    await waitFor(() => showsCursor(editor, ownerId, cursorAt(3)), 3000)
    owner.provider.setAwarenessField('cursor', null)
    await waitFor(() => stateOf(editor, ownerId)?.cursor === null, 3000, 'the cursor to be cleared')
    owner.provider.setAwarenessField('cursor', cursorAt(5))
    await waitFor(() => showsCursor(editor, ownerId, cursorAt(5)), 3000)
    cleanup()
  })

  it('removes a person\'s cursor when they disconnect', async () => {
    const page = await freshPage()
    const owner = open(team.owner, page.doc)
    const editor = open(team.editor, page.doc)
    await Promise.all([owner.synced, editor.synced])
    const editorId = editor.provider.awareness!.clientID
    editor.provider.setAwarenessField('cursor', cursorAt(1))
    await waitFor(() => stateOf(owner, editorId) !== undefined, 3000)
    editor.destroy()
    await waitFor(() => stateOf(owner, editorId) === undefined, 5000, 'the cursor to disappear')
    cleanup()
  })
})

describe('saving', () => {
  it('writes the page to the database when the last person leaves, and the next visitor gets it back', async () => {
    const page = await freshPage()
    const first = open(team.editor, page.doc)
    await first.synced
    typeInto(first, 'remember me')
    await waitFor(() => first.provider.unsyncedChanges === 0)
    first.destroy()
    await untilUnloaded(server)
    assert.equal(await savedText(server.db, page.id), 'remember me')

    const second = open(team.viewer, page.doc)
    await second.synced
    assert.equal(textOf(second), 'remember me')
    cleanup()
  })

  it('keeps editing from several people merged, whatever the order they arrive in', async () => {
    const page = await freshPage()
    const a = open(team.owner, page.doc)
    const b = open(team.editor, page.doc)
    await Promise.all([a.synced, b.synced])
    a.doc.getText('t').insert(0, 'AAA')
    b.doc.getText('t').insert(0, 'BBB')
    await waitFor(() => textOf(a).length === 6 && textOf(a) === textOf(b), 3000, 'both to converge')
    const merged = textOf(a)
    cleanup()
    await untilUnloaded(server)
    assert.equal(await savedText(server.db, page.id), merged)
    cleanup()
  })

  it('does not write pages that were never edited', async () => {
    const page = await freshPage()
    const peer = open(team.viewer, page.doc)
    await peer.synced
    cleanup()
    await untilUnloaded(server)
    const saved = await savedText(server.db, page.id)
    assert.ok(saved === null || saved === '')
  })

  it('bumps the page\'s "updated" time when it is saved', async () => {
    const page = await freshPage()
    const before = (await team.owner.get(`/api/workspaces/${team.ws}/pages`)).body.pages.find((p: { id: string }) => p.id === page.id).updatedAt
    await settle(30)
    const peer = open(team.owner, page.doc)
    await peer.synced
    typeInto(peer, 'x')
    await waitFor(() => peer.provider.unsyncedChanges === 0)
    cleanup()
    await untilUnloaded(server)
    const after = (await team.owner.get(`/api/workspaces/${team.ws}/pages`)).body.pages.find((p: { id: string }) => p.id === page.id).updatedAt
    assert.ok(new Date(after).getTime() > new Date(before).getTime())
  })
})

describe('restarts', () => {
  it('keeps everyone signed in and every saved edit, even edits made a moment before shutdown', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conflux-db-'))
    try {
      const first = await startTestServer({ dataDir: dir })
      const writer = new Client(first)
      const account = await writer.signup('Writer')
      const page = await writer.createPage(account.workspace.id, 'Survivor')
      const peer = openDoc(first, writer, `page.${page.id}`)
      await peer.synced
      typeInto(peer, 'written just before the lights went out')
      // acknowledged by the server, but well inside the 1 second save delay
      await waitFor(() => peer.provider.unsyncedChanges === 0)
      const cookie = writer.cookie
      peer.destroy()
      await first.close()

      const second = await startTestServer({ dataDir: dir })
      try {
        const reader = new Client(second)
        reader.cookie = cookie
        assert.equal((await reader.get('/api/auth/me')).status, 200, 'the session survived the restart')
        const again = openDoc(second, reader, `page.${page.id}`)
        await again.synced
        assert.equal(textOf(again), 'written just before the lights went out')
        again.destroy()
      } finally {
        await second.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
