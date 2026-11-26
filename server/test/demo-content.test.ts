import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PAGE_TEXT_FIELD } from '@conflux/shared'
import * as Y from 'yjs'
import { DEMO_PAGES, buildDemoPages, documentFor, type Block } from '../src/demo/content'
import { editorSchema, editorView } from './demo-schema'

const load = (state: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

describe('the starter pages of a demo', () => {
  it('are exactly what the editor needs: every node and mark is one it knows, nothing is thrown away', () => {
    for (const page of buildDemoPages()) {
      const root = editorView(load(page.state))
      assert.ok(root.childCount > 3, page.title)
    }
  })

  it('keep their blocks, in order, with all their text', () => {
    for (const [index, page] of buildDemoPages().entries()) {
      const seed = DEMO_PAGES[index]
      const root = editorView(load(page.state))
      assert.equal(root.childCount, seed.blocks.length, seed.title)
      assert.deepEqual(
        root.content.content.map((node) => node.type.name),
        seed.blocks.map((block) => block.type),
        seed.title,
      )
    }
  })

  it('keep the order of text that is made of several runs (plain, bold, italic, code)', () => {
    const welcome = editorView(load(buildDemoPages()[0].state))
    const steps = welcome.content.content.find((node) => node.type.name === 'orderedList')! // under "Try it with a friend"
    assert.ok(steps)
    assert.equal(steps.child(0).textContent, 'Press Invite someone in the top bar and send the link, or open it in a second window.')
    assert.equal(steps.child(2).textContent, 'Write @bot help on a line of its own and the bot answers.')

    const notes = editorView(load(buildDemoPages()[1].state))
    assert.equal(notes.child(1).textContent, 'Date: next Tuesday. Everyone is made up, too.')
  })

  it('carry their formatting as the editor’s own marks, on the right words', () => {
    const welcome = editorView(load(buildDemoPages()[0].state))
    const marked: Record<string, string[]> = {}
    welcome.descendants((node) => {
      if (node.isText) for (const mark of node.marks) (marked[mark.type.name] ??= []).push(node.text!)
    })
    assert.deepEqual(marked.bold, ['Invite someone'])
    assert.deepEqual(marked.code, ['@bot help'])
    const notes = editorView(load(buildDemoPages()[1].state))
    const italics: string[] = []
    notes.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'italic')) italics.push(node.text!)
    })
    assert.deepEqual(italics, ['next Tuesday'])
  })

  it('give headings a real level and task items a real checked state', () => {
    const welcome = editorView(load(buildDemoPages()[0].state))
    const levels = welcome.content.content.filter((node) => node.type.name === 'heading').map((node) => node.attrs.level)
    assert.deepEqual(levels, [1, 2, 2])
    const tasks = welcome.content.content.find((node) => node.type.name === 'taskList')!
    assert.deepEqual(tasks.content.content.map((item) => item.attrs.checked), [true, true, false])
    const ideas = editorView(load(buildDemoPages()[2].state))
    assert.equal(ideas.child(2).attrs.level, 3)
  })

  it('make no demo-specific claims about real people or companies, and carry no links or scripts', () => {
    for (const page of buildDemoPages()) {
      const root = editorView(load(page.state))
      root.descendants((node) => {
        assert.ok(!node.marks.some((mark) => mark.type.name === 'link'), 'no links in starter pages')
      })
      assert.doesNotMatch(root.textContent, /https?:|www\.|@[a-z0-9-]+\.[a-z]{2,}/i, 'no addresses')
    }
  })

  it('are small and independent: each page is a few kilobytes, and building twice gives separate documents', () => {
    const first = buildDemoPages()
    const second = buildDemoPages()
    for (const page of first) assert.ok(page.state.byteLength < 8 * 1024, `${page.title}: ${page.state.byteLength} bytes`)
    assert.deepEqual(first.map((page) => page.title), ['Welcome to the demo', 'Team notes', 'Ideas board'])
    assert.notEqual(first[0].state, second[0].state)
  })
})

describe('the editor’s schema', () => {
  it('is the one the starter pages assume: these are the node types and marks a demo page may use', () => {
    const nodes = Object.keys(editorSchema.nodes)
    for (const name of ['doc', 'paragraph', 'text', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem']) {
      assert.ok(nodes.includes(name), `the editor knows "${name}"`)
    }
    for (const name of ['bold', 'italic', 'code']) assert.ok(name in editorSchema.marks, `the editor knows the "${name}" mark`)
  })

  it('refuses a node it does not know (this is what the check above would catch)', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(PAGE_TEXT_FIELD)
    const stranger = new Y.XmlElement('callout')
    stranger.insert(0, [new Y.XmlText('hello')])
    fragment.insert(0, [stranger])
    assert.throws(() => editorView(doc), /throw part of the page away/)
  })

  it('refuses a list item with no paragraph in it, which the editor would also have to repair', () => {
    const blocks: Block[] = [{ type: 'bulletList', items: ['fine'] }]
    const doc = load(documentFor(blocks))
    const item = (doc.getXmlFragment(PAGE_TEXT_FIELD).get(0) as Y.XmlElement).get(0) as Y.XmlElement
    item.delete(0, 1)
    assert.throws(() => editorView(doc))
  })
})
