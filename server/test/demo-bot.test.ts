import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'
import { CLOSE_CODES, DEMO_BOT, DEMO_BOT_COMMANDS, DEMO_BOT_MENTION, PAGE_TEXT_FIELD } from '@conflux/shared'
import * as Y from 'yjs'
import { BOT_PREFIX, GREETING, plainText, replyFor } from '../src/sync/bot'
import { settle, startTestServer, untilClosed, waitFor, type Peer, type TestServer } from './helpers'
import { addParagraph, blocksOf, fragmentOf, joinAs, makeDemo, openDemoDoc, savedDemoText, type Visitor } from './demo-helpers'
import { editorView } from './demo-schema'

const FAST = { botReplyDelayMs: 50, botTypeDelayMs: 1 }
const withDemo = (changes: Partial<TestServer['config']['demo']>) => ({ patch: (config: TestServer['config']) => ({ ...config, demo: { ...config.demo, ...changes } }) })
const servers: TestServer[] = []
const peers: Peer[] = []
afterEach(() => {
  for (const peer of peers.splice(0)) peer.destroy()
})
after(async () => {
  for (const server of servers.splice(0)) await server.close()
})

const boot = async (changes: Partial<TestServer['config']['demo']> = FAST) => {
  const server = await startTestServer(withDemo(changes))
  servers.push(server)
  return server
}
const open = (server: TestServer, visitor: Visitor, pageId: string) => {
  const peer = openDemoDoc(server, visitor, pageId)
  peers.push(peer)
  return peer
}
const botLines = (peer: Peer) => blocksOf(peer).filter((block) => block.startsWith(BOT_PREFIX))
const NO_COUNTS = { paragraphs: 0, words: 0 }
async function quietPage(server: TestServer, pageIndex = 0) {
  const { ticket, host } = await makeDemo(server)
  const page = host.state.pages[pageIndex].id
  const peer = open(server, host, page)
  await peer.synced
  await waitFor(() => botLines(peer)[0] === GREETING, 10_000, 'the bot’s greeting to be typed')
  return { ticket, host, page, peer }
}
const lineAfter = (peer: Peer, line: string) => {
  const blocks = blocksOf(peer)
  const index = blocks.indexOf(line)
  return index < 0 ? undefined : blocks[index + 1]
}

describe('what the bot says', () => {
  it('has fixed sentences for every command, all starting with its mark, and never repeats the command it was given', () => {
    for (const command of DEMO_BOT_COMMANDS) assert.ok(replyFor(command, NO_COUNTS).startsWith(BOT_PREFIX), command)
    assert.equal(replyFor('help', NO_COUNTS), `${BOT_PREFIX} I understand: ${DEMO_BOT_COMMANDS.map((name) => `${DEMO_BOT_MENTION} ${name}`).join(', ')}.`)
    assert.equal(replyFor('count', { paragraphs: 7, words: 42 }), `${BOT_PREFIX} This page has 7 blocks of text and 42 words.`)
    for (const hostile of ['<script>alert(1)</script>', '${process.env.SECRET}', '`rm -rf`', 'A'.repeat(10_000), '__proto__', 'constructor', 'toString']) {
      const reply = replyFor(hostile, NO_COUNTS)
      assert.equal(reply, `${BOT_PREFIX} I do not know that one. Try ${DEMO_BOT_MENTION} help.`)
      assert.ok(reply.length < 100)
    }
  })

  it('reads the text of nested blocks and marked text', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment(PAGE_TEXT_FIELD)
    const list = new Y.XmlElement('bulletList')
    const item = new Y.XmlElement('listItem')
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    text.insert(0, 'plain ')
    text.insert(6, 'bold', { bold: {} })
    paragraph.insert(0, [text])
    item.insert(0, [paragraph])
    list.insert(0, [item])
    fragment.insert(0, [list])
    assert.equal(plainText(fragment).trim(), 'plain bold')
  })
})

describe('arriving and leaving', () => {
  it('greets once, a few seconds after the first visitor arrives, and not again when more people come', async () => {
    const server = await boot()
    const { ticket, peer, page } = await quietPage(server)
    assert.deepEqual(botLines(peer), [GREETING])
    const guest = await joinAs(server, ticket)
    const second = open(server, guest, page)
    await second.synced
    await settle(2600)
    assert.deepEqual(botLines(second), [GREETING], 'still one greeting')
  })

  it('shows up in the list of people with its own name, colour and cursor', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    const states = [...peer.provider.awareness!.getStates().values()]
    const bot = states.find((state) => (state.user as { name?: string } | undefined)?.name === DEMO_BOT.name)
    assert.ok(bot, 'the bot is in the presence list')
    assert.equal((bot.user as { color: string }).color, DEMO_BOT.color)
    assert.ok((bot.cursor as { anchor: unknown } | undefined)?.anchor, 'its cursor sits where it last typed')
  })

  it('leaves a few seconds after the last visitor does, and is back for the next one', async () => {
    const server = await boot()
    assert.equal(server.sync.stats().bots, 0, 'no bot where nobody is')
    const { host, page, peer } = await quietPage(server)
    assert.equal(server.sync.stats().bots, 1)
    peer.destroy()
    await settle(1200)
    assert.equal(server.sync.stats().bots, 1, 'it waits a moment in case the page is just being reloaded')
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')
    const again = open(server, host, page)
    await again.synced
    await waitFor(() => server.sync.stats().bots === 1, 4000, 'the bot to come back')
  })

  it('does not greet a page again on a later visit, and keeps its earlier words saved with the page', async () => {
    const server = await boot()
    const { host, page, peer } = await quietPage(server)
    await waitFor(async () => ((await savedDemoText(server, page)) ?? '').includes(GREETING), 10_000, 'the greeting to be saved')
    peer.destroy()
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')
    const later = open(server, host, page)
    await later.synced
    await settle(2600)
    assert.deepEqual(botLines(later), [GREETING])
  })
})

describe('answering commands', () => {
  it('answers "@bot help" right under the line that asked, in its fixed words', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    addParagraph(peer, '@bot help')
    addParagraph(peer, '')
    await waitFor(() => lineAfter(peer, '@bot help') === replyFor('help', NO_COUNTS), 6000, 'the answer to appear under the question')
  })

  it('waits for Enter: a command on the last line is not answered until something follows it', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    addParagraph(peer, '@bot hello')
    await settle(900)
    assert.equal(lineAfter(peer, '@bot hello'), undefined, 'nothing yet')
    addParagraph(peer, 'next line')
    await waitFor(() => lineAfter(peer, '@bot hello') === replyFor('hello', NO_COUNTS), 6000, 'the answer after Enter')
  })

  it('answers "@bot", "@bot HELP" and "@BOT  count" (case and spaces do not matter), and a bare "@bot" means help', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    for (const line of ['@bot', '@bot HELP', '@BOT   todo']) {
      addParagraph(peer, line)
      addParagraph(peer, 'x')
    }
    await waitFor(() => lineAfter(peer, '@bot') === replyFor('help', NO_COUNTS), 6000)
    await waitFor(() => lineAfter(peer, '@bot HELP') === replyFor('help', NO_COUNTS), 6000)
    await waitFor(() => lineAfter(peer, '@BOT   todo') === replyFor('todo', NO_COUNTS), 6000)
  })

  it('counts the real page: the numbers in its answer are the ones on the page when it answered', async () => {
    const server = await boot()
    const { peer } = await quietPage(server, 2)
    addParagraph(peer, '@bot count')
    addParagraph(peer, 'one two three')
    await waitFor(() => botLines(peer).some((line) => /^🤖 This page has \d+ blocks of text and \d+ words\.$/.test(line)), 6000, 'the whole count')
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(peer.doc))
    const fragment = copy.getXmlFragment(PAGE_TEXT_FIELD)
    const answer = fragment.toArray().findIndex((block) => block instanceof Y.XmlElement && plainText(block).includes('This page has'))
    const said = /(\d+) blocks of text and (\d+) words/.exec(plainText(fragment.get(answer) as Y.XmlElement))!
    fragment.delete(answer, 1)
    const countBlocks = (parent: Y.XmlFragment | Y.XmlElement): number =>
      parent.toArray().reduce((total: number, child) => {
        if (!(child instanceof Y.XmlElement)) return total
        if (['paragraph', 'heading', 'codeBlock'].includes(child.nodeName)) return total + (plainText(child).trim() === '' ? 0 : 1)
        return total + countBlocks(child)
      }, 0)
    assert.equal(Number(said[1]), countBlocks(fragment))
    assert.equal(Number(said[2]), plainText(fragment).split(/\s+/).filter(Boolean).length)
    assert.ok(Number(said[1]) >= 8 && Number(said[2]) > 30, `${said[0]} is about the size of this page`)
  })

  it('writes lines the real editor accepts exactly as they are (it would otherwise throw them away for everybody)', async () => {
    const server = await boot()
    const { peer } = await quietPage(server, 2)
    for (const line of ['@bot help', '@bot count', '@bot todo']) addParagraph(peer, line)
    addParagraph(peer, 'the end')
    await waitFor(() => botLines(peer).length === 4 && botLines(peer).every((line) => /[.!]$/.test(line)), 10_000, 'the greeting and three answers, fully typed')
    const root = editorView(peer.doc)
    assert.ok(root.textContent.includes(GREETING))
  })

  it('also answers a command typed in a bullet list or a quote: right under it, inside the same item', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    const paragraph = (text: string) => {
      const block = new Y.XmlElement('paragraph')
      if (text) block.insert(0, [new Y.XmlText(text)])
      return block
    }
    const item = (text: string) => {
      const entry = new Y.XmlElement('listItem')
      entry.insert(0, [paragraph(text)])
      return entry
    }
    const list = new Y.XmlElement('bulletList')
    const quote = new Y.XmlElement('blockquote')
    peer.doc.transact(() => {
      list.insert(0, [item('@bot hello'), item('')])
      quote.insert(0, [paragraph('@bot todo'), paragraph('')])
      fragmentOf(peer).insert(fragmentOf(peer).length, [list, quote])
    })
    const textOf = (parent: Y.XmlElement, index: number) => {
      const child = parent.get(index)
      return child instanceof Y.XmlElement ? plainText(child) : undefined
    }
    const firstItem = list.get(0) as Y.XmlElement
    await waitFor(() => textOf(firstItem, 1) === replyFor('hello', NO_COUNTS), 6000, 'the answer inside the bullet')
    await waitFor(() => textOf(quote, 1) === replyFor('todo', NO_COUNTS), 6000, 'the answer inside the quote')
    assert.equal(textOf(firstItem, 0), '@bot hello', 'the question is still first')
    assert.equal(textOf(quote, 0), '@bot todo')
    assert.equal(textOf(quote, 2), '', 'and the empty line the visitor left is after the answer')
    assert.equal(list.length, 2, 'no new bullet was made')
    editorView(peer.doc) // the editor accepts all of it as it is
  })

  it('does not take a heading or a code block for a command', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    const heading = new Y.XmlElement('heading')
    heading.setAttribute('level', 2 as never)
    heading.insert(0, [new Y.XmlText('@bot help')])
    const code = new Y.XmlElement('codeBlock')
    code.insert(0, [new Y.XmlText('@bot help')])
    peer.doc.transact(() => fragmentOf(peer).insert(fragmentOf(peer).length, [heading, code]))
    addParagraph(peer, 'the end')
    await settle(1000)
    assert.deepEqual(botLines(peer), [GREETING], 'nothing but the greeting')
  })

  it('ignores a line that is not exactly "@bot" and at most one word', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    for (const line of ['please @bot help me', '@bot help please', 'hey @bot', '@botty help', '@bot-help', '@bot​help', 'e-mail@bot help']) addParagraph(peer, line)
    addParagraph(peer, 'the end')
    await settle(1000)
    assert.deepEqual(botLines(peer), [GREETING], 'nothing but the greeting')
  })

  it('never repeats what a visitor wrote, however hostile or long', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    const unknown = replyFor('nope', NO_COUNTS)
    addParagraph(peer, '@bot <script>alert(1)</script>')
    addParagraph(peer, `@bot ${'A'.repeat(5000)}`)
    addParagraph(peer, 'end')
    await waitFor(() => botLines(peer).filter((line) => line === unknown).length === 2, 6000, 'two "I do not know" answers')
    assert.ok(!botLines(peer).join('').includes('script'))
    assert.ok(!botLines(peer).join('').includes('AAAA'))
  })

  it('answers an edited command again, but never answers the same line twice', async () => {
    const server = await boot()
    const { peer } = await quietPage(server)
    addParagraph(peer, '@bot hello')
    addParagraph(peer, 'x')
    const hello = replyFor('hello', NO_COUNTS)
    await waitFor(() => botLines(peer).includes(hello), 6000)
    addParagraph(peer, 'unrelated edit')
    await settle(700)
    assert.equal(botLines(peer).filter((line) => line === hello).length, 1, 'still one answer')

    // The visitor changes the command in place.
    const command = fragmentOf(peer).toArray().find((block) => block instanceof Y.XmlElement && plainText(block) === '@bot hello') as Y.XmlElement
    const text = command.get(0) as Y.XmlText
    peer.doc.transact(() => {
      text.delete(0, text.length)
      text.insert(0, '@bot todo')
    })
    await waitFor(() => botLines(peer).includes(replyFor('todo', NO_COUNTS)), 6000, 'the answer to the edited command')
  })

  it('does not answer old commands again when it comes back for a later visit', async () => {
    const server = await boot()
    const { host, page, peer } = await quietPage(server)
    addParagraph(peer, '@bot hello')
    addParagraph(peer, 'x')
    const hello = replyFor('hello', NO_COUNTS)
    await waitFor(() => botLines(peer).includes(hello), 6000)
    await waitFor(async () => ((await savedDemoText(server, page)) ?? '').includes(hello), 10_000, 'the answer to be saved')
    peer.destroy()
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')

    const later = open(server, host, page)
    await later.synced
    await settle(2600)
    assert.deepEqual(botLines(later), [GREETING, hello], 'the old answer is there once, nothing new')
  })

  it('stops at its limit, says so once, and then stays quiet', async () => {
    const server = await boot({ ...FAST, botMaxReplies: 2 })
    const { peer } = await quietPage(server)
    for (const mark of ['a', 'b', 'c', 'd']) {
      addParagraph(peer, '@bot hello')
      addParagraph(peer, mark)
    }
    await waitFor(() => botLines(peer).filter((line) => line.includes('That is all the answers')).length === 1, 8000, 'the limit message')
    await settle(1200)
    const lines = botLines(peer)
    assert.equal(lines.filter((line) => line === replyFor('hello', NO_COUNTS)).length, 2)
    assert.equal(lines.filter((line) => line.includes('That is all the answers')).length, 1)
    assert.equal(lines.length, 4, 'greeting, two answers, one limit message')
  })

  it('writes at a human pace with the normal settings: it waits for a pause, then types, letter by letter', async () => {
    const server = await boot({})
    const { peer } = await quietPage(server)
    const asked = Date.now()
    addParagraph(peer, '@bot hello')
    addParagraph(peer, 'x')
    const hello = replyFor('hello', NO_COUNTS)
    await waitFor(() => lineAfter(peer, '@bot hello') !== undefined && lineAfter(peer, '@bot hello')!.startsWith(BOT_PREFIX), 6000, 'the first letters')
    const firstLetters = Date.now() - asked
    assert.ok(firstLetters > 900, `it did not answer instantly (${firstLetters} ms)`)
    await waitFor(() => lineAfter(peer, '@bot hello') === hello, 8000, 'the whole answer')
    assert.ok(Date.now() - asked > 1900, 'typing the answer takes a moment')
  })
})

describe('what the bot does not do', () => {
  it('does not keep a demo alive: only people typing do', async () => {
    const server = await startTestServer(withDemo({ idleSeconds: 2, maxSeconds: 600, botTypeDelayMs: 35 }))
    servers.push(server)
    const { host } = await makeDemo(server)
    const joined = Date.now()
    const peer = open(server, host, host.state.pages[0].id)
    await peer.synced
    // The bot greets at about 1.5 s and then types for several more seconds. If its typing counted as activity, the demo would live on.
    await untilClosed(peer, CLOSE_CODES.demoEnded, 7000)
    assert.ok(Date.now() - joined < 6500, `the demo ended after ${Date.now() - joined} ms`)
  })

  it('is not there when the demo has ended', async () => {
    const server = await boot()
    const { host, peer } = await quietPage(server)
    assert.equal((await host.client.post('/api/demo/end')).status, 204)
    await untilClosed(peer, CLOSE_CODES.demoEnded, 3000)
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')
  })
})
