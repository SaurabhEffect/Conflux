import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'

/**
 * Why does Conflux work at all?
 *
 * Yjs documents are CRDTs: no matter in which order, or how late, two people's
 * edits are delivered, every copy ends up exactly the same. There is no "who
 * wins" server deciding. Read these tests top to bottom.
 */

/** Send everything `from` knows to `to` (this is what the WebSocket does for us). */
function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from))
}

test('two people typing in different places both keep their changes', () => {
  const alice = new Y.Doc()
  const bob = new Y.Doc()
  alice.getText('page').insert(0, 'Hello world')
  sync(alice, bob) // Bob opens the page and receives the text

  // Both go offline and edit at the same time (no updates are exchanged yet).
  alice.getText('page').insert(5, ' brave') // Hello brave world
  bob.getText('page').insert(11, '!') //         Hello world!

  // The network comes back. Updates cross in both directions.
  sync(alice, bob)
  sync(bob, alice)

  assert.equal(alice.getText('page').toString(), 'Hello brave world!')
  assert.equal(bob.getText('page').toString(), 'Hello brave world!')
})

test('two people typing in the SAME spot: nothing is lost and both screens agree', () => {
  const alice = new Y.Doc()
  const bob = new Y.Doc()
  alice.getText('page').insert(0, 'Notes: ')
  sync(alice, bob)
  alice.getText('page').insert(7, 'ALICE')
  bob.getText('page').insert(7, 'BOB')
  sync(alice, bob)
  sync(bob, alice)
  const a = alice.getText('page').toString()
  const b = bob.getText('page').toString()
  assert.equal(a, b, 'both copies must be identical')
  assert.ok(a.includes('ALICE') && a.includes('BOB'), 'neither edit may disappear')
})

test('the order updates arrive in does not matter', () => {
  const author = new Y.Doc()
  const updates: Uint8Array[] = []
  author.on('update', (update: Uint8Array) => updates.push(update))
  const text = author.getText('page')
  text.insert(0, 'one ')
  text.insert(4, 'two ')
  text.insert(8, 'three')
  const inOrder = new Y.Doc()
  updates.forEach((u) => Y.applyUpdate(inOrder, u))
  const backwards = new Y.Doc()
  ;[...updates].reverse().forEach((u) => Y.applyUpdate(backwards, u))
  assert.equal(inOrder.getText('page').toString(), 'one two three')
  assert.equal(backwards.getText('page').toString(), 'one two three')
})

test('the page list: two people create pages at once, both pages exist everywhere', () => {
  // This is exactly how the sidebar list works: a Y.Map of pages.
  const alice = new Y.Doc()
  const bob = new Y.Doc()
  alice.getMap<Y.Map<unknown>>('pages').set('aaaaaaaa', new Y.Map([['title', 'Maths notes']]))
  bob.getMap<Y.Map<unknown>>('pages').set('bbbbbbbb', new Y.Map([['title', 'Project ideas']]))
  sync(alice, bob)
  sync(bob, alice)
  assert.deepEqual([...alice.getMap('pages').keys()].sort(), ['aaaaaaaa', 'bbbbbbbb'])
  assert.deepEqual([...bob.getMap('pages').keys()].sort(), ['aaaaaaaa', 'bbbbbbbb'])
})
