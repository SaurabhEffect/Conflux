import { PAGE_TEXT_FIELD } from '@conflux/shared'
import * as Y from 'yjs'

type Run = string | { text: string; bold?: true; italic?: true; code?: true }
type Runs = Run | Run[]

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: Runs }
  | { type: 'paragraph'; text: Runs }
  | { type: 'blockquote'; text: Runs }
  | { type: 'bulletList'; items: Runs[] }
  | { type: 'orderedList'; items: Runs[] }
  | { type: 'taskList'; items: { text: Runs; checked: boolean }[] }

const asRuns = (runs: Runs): Run[] => (Array.isArray(runs) ? runs : [runs])

function textNode(runs: Runs): Y.XmlText {
  const text = new Y.XmlText()
  let offset = 0
  for (const run of asRuns(runs)) {
    const plain = typeof run === 'string'
    const value = plain ? run : run.text
    const marks = {
      bold: !plain && run.bold ? {} : null,
      italic: !plain && run.italic ? {} : null,
      code: !plain && run.code ? {} : null,
    }
    text.insert(offset, value, marks)
    offset += value.length
  }
  return text
}

function paragraph(runs: Runs): Y.XmlElement {
  const element = new Y.XmlElement('paragraph')
  element.insert(0, [textNode(runs)])
  return element
}

function listItem(name: 'listItem' | 'taskItem', runs: Runs, attrs: Record<string, unknown> = {}): Y.XmlElement {
  const item = new Y.XmlElement(name)
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value as string)
  item.insert(0, [paragraph(runs)])
  return item
}

function build(block: Block): Y.XmlElement {
  switch (block.type) {
    case 'heading': {
      const heading = new Y.XmlElement('heading')
      heading.setAttribute('level', block.level as unknown as string)
      heading.insert(0, [textNode(block.text)])
      return heading
    }
    case 'paragraph':
      return paragraph(block.text)
    case 'blockquote': {
      const quote = new Y.XmlElement('blockquote')
      quote.insert(0, [paragraph(block.text)])
      return quote
    }
    case 'bulletList':
    case 'orderedList': {
      const list = new Y.XmlElement(block.type)
      list.insert(0, block.items.map((item) => listItem('listItem', item)))
      return list
    }
    case 'taskList': {
      const list = new Y.XmlElement('taskList')
      list.insert(0, block.items.map((item) => listItem('taskItem', item.text, { checked: item.checked })))
      return list
    }
  }
}

export function documentFor(blocks: Block[]): Uint8Array {
  const doc = new Y.Doc()
  doc.getXmlFragment(PAGE_TEXT_FIELD).insert(0, blocks.map(build))
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

export type DemoPageSeed = { title: string; blocks: Block[] }

export const DEMO_PAGES: readonly DemoPageSeed[] = [
  {
    title: 'Welcome to the demo',
    blocks: [
      { type: 'heading', level: 1, text: 'Welcome to the Conflux demo' },
      {
        type: 'paragraph',
        text: 'This is a throw-away sandbox. Nothing here is real, you did not need an account, and everything is deleted when the demo ends.',
      },
      { type: 'heading', level: 2, text: 'Try it with a friend' },
      {
        type: 'orderedList',
        items: [
          ['Press ', { text: 'Invite someone', bold: true }, ' in the top bar and send the link, or open it in a second window.'],
          'Type on this page in both windows. Each of you gets a coloured cursor, and nobody overwrites anybody.',
          ['Write ', { text: '@bot help', code: true }, ' on a line of its own and the bot answers.'],
          'Refresh the page: your edits are still here.',
        ],
      },
      { type: 'heading', level: 2, text: 'What is going on' },
      {
        type: 'paragraph',
        text: 'Every key press becomes a tiny update that is merged with everybody else’s by a CRDT, so two people typing at once always end up with the same page.',
      },
      {
        type: 'taskList',
        items: [
          { text: 'Live editing with shared cursors', checked: true },
          { text: 'A bot that writes next to you', checked: true },
          { text: 'Your idea goes here', checked: false },
        ],
      },
    ],
  },
  {
    title: 'Team notes',
    blocks: [
      { type: 'heading', level: 1, text: 'Sprint planning (made up)' },
      { type: 'paragraph', text: ['Date: ', { text: 'next Tuesday', italic: true }, '. Everyone is made up, too.'] },
      { type: 'heading', level: 2, text: 'Agenda' },
      {
        type: 'bulletList',
        items: ['Review last week’s demo', 'Pick the three most important fixes', 'Decide who writes the release notes'],
      },
      { type: 'heading', level: 2, text: 'Actions' },
      {
        type: 'taskList',
        items: [
          { text: 'Draft the release notes', checked: false },
          { text: 'Fix the login typo', checked: true },
          { text: 'Book the review meeting', checked: false },
        ],
      },
    ],
  },
  {
    title: 'Ideas board',
    blocks: [
      { type: 'heading', level: 1, text: 'Ideas board' },
      { type: 'blockquote', text: 'A good idea is a bad idea that somebody wrote down and kept editing.' },
      { type: 'heading', level: 3, text: 'Parking lot' },
      { type: 'bulletList', items: ['A dark theme for the office plants’ dashboard', 'A friendlier name for “Sprint”', 'Snacks'] },
      { type: 'paragraph', text: 'Add yours below. The bot will not steal them.' },
    ],
  },
]

export function buildDemoPages(): { title: string; position: number; state: Uint8Array }[] {
  return DEMO_PAGES.map((page, position) => ({ title: page.title, position, state: documentFor(page.blocks) }))
}
