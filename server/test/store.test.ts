import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as Y from 'yjs'
import { isValidDocumentName } from '../src/documentNames'
import { DocumentStore } from '../src/store'

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'conflux-test-'))
}

test('a document that was never saved loads as null', () => {
  const store = new DocumentStore(':memory:')
  assert.equal(store.load('page:abcdefgh'), null)
  store.close()
})

test('save then load gives back the same document', () => {
  const store = new DocumentStore(':memory:')
  const doc = new Y.Doc()
  doc.getText('page').insert(0, 'remember me')
  store.save('page:abcdefgh', Y.encodeStateAsUpdate(doc))
  const saved = store.load('page:abcdefgh')
  assert.ok(saved)
  const restored = new Y.Doc()
  Y.applyUpdate(restored, saved)
  assert.equal(restored.getText('page').toString(), 'remember me')
  store.close()
})

test('saving twice replaces the old copy (one row per document)', () => {
  const store = new DocumentStore(':memory:')
  const doc = new Y.Doc()
  doc.getText('page').insert(0, 'v1')
  store.save('workspace', Y.encodeStateAsUpdate(doc))
  doc.getText('page').insert(2, ' and v2')
  store.save('workspace', Y.encodeStateAsUpdate(doc))
  assert.equal(store.count(), 1)
  const restored = new Y.Doc()
  Y.applyUpdate(restored, store.load('workspace')!)
  assert.equal(restored.getText('page').toString(), 'v1 and v2')
  store.close()
})

test('data survives closing and re-opening the database file (a server restart)', () => {
  const dir = makeTempDir()
  const file = join(dir, 'conflux.db')
  try {
    const first = new DocumentStore(file)
    const doc = new Y.Doc()
    doc.getText('page').insert(0, 'still here after restart')
    first.save('page:restart01', Y.encodeStateAsUpdate(doc))
    first.close()
    const second = new DocumentStore(file)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, second.load('page:restart01')!)
    assert.equal(restored.getText('page').toString(), 'still here after restart')
    second.close()
  } 
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only our own document names are allowed', () => {
  assert.equal(isValidDocumentName('workspace'), true)
  assert.equal(isValidDocumentName('page:k3j2h4g5f6d7s8a9'), true)
  assert.equal(isValidDocumentName(''), false)
  assert.equal(isValidDocumentName('page:'), false)
  assert.equal(isValidDocumentName('page:short'), false)
  assert.equal(isValidDocumentName('../../etc/passwd'), false)
  assert.equal(isValidDocumentName('Workspace'), false)
  assert.equal(isValidDocumentName('page:abcdefgh\nextra'), false)
})
