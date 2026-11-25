import { DEMO_BOT, DEMO_BOT_COMMANDS, DEMO_BOT_MENTION, PAGE_TEXT_FIELD, type DemoBotCommand } from '@conflux/shared'
import type { Document, Hocuspocus } from '@hocuspocus/server'
import type { FastifyBaseLogger } from 'fastify'
import * as Y from 'yjs'
import type { Config } from '../config'
type DirectConnection = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>

export type BotDeps = {
  hocuspocus: Pick<Hocuspocus<any>, 'openDirectConnection'>
  demo: Config['demo']
  log: FastifyBaseLogger
  reserveAwareness: (docName: string, clientId: number) => void
  releaseAwareness: (docName: string, clientId: number) => void
}

export type Bots = {
  humanJoined: (docName: string) => void
  humanLeft: (docName: string, remaining: number) => void
  stats: () => { sessions: number }
  close: () => Promise<void>
}

const LINGER_MS = 3000
const GREETING_DELAY_MS = 1500
export const BOT_PREFIX = '🤖'
const COMMAND_RE = new RegExp(`^${DEMO_BOT_MENTION}(?:\\s+(\\S+))?$`, 'i')
export const BOT_CONTEXT = { bot: true } as const

type Session = {
  docName: string
  direct: DirectConnection | null
  document: Document | null
  stopped: boolean
  starting: Promise<void>
  stopping: Promise<void> | null
  timers: Set<NodeJS.Timeout>
  queue: Promise<void>
  handled: Map<string, string>
  replies: number
  checkTimer: NodeJS.Timeout | null
  lingerTimer: NodeJS.Timeout | null
  onUpdate: ((update: Uint8Array, origin: unknown) => void) | null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function plainText(node: Y.XmlElement | Y.XmlText | Y.XmlFragment): string {
  if (node instanceof Y.XmlText) {
    return (node.toDelta() as { insert?: unknown }[]).map((part) => (typeof part.insert === 'string' ? part.insert : '')).join('')
  }
  return node
    .toArray()
    .map((child) => (child instanceof Y.XmlElement || child instanceof Y.XmlText ? plainText(child) : ''))
    .join(' ')
}

export function replyFor(command: string, counts: { paragraphs: number; words: number }): string {
  switch (command as DemoBotCommand) {
    case 'help':
      return `${BOT_PREFIX} I understand: ${DEMO_BOT_COMMANDS.map((name) => `${DEMO_BOT_MENTION} ${name}`).join(', ')}.`
    case 'count':
      return `${BOT_PREFIX} This page has ${counts.paragraphs} blocks of text and ${counts.words} words.`
    case 'todo':
      return `${BOT_PREFIX} Suggested next steps: invite a friend, edit another page, then end the demo from the top bar.`
    case 'hello':
      return `${BOT_PREFIX} Hello! It is nice to write together.`
    default:
      return `${BOT_PREFIX} I do not know that one. Try ${DEMO_BOT_MENTION} help.`
  }
}

export const GREETING = `${BOT_PREFIX} Hi, I am ${DEMO_BOT.name}. Write ${DEMO_BOT_MENTION} help on a line of its own, press Enter, and I will answer.`
const isBotLine = (node: unknown): boolean => node instanceof Y.XmlElement && plainText(node).trimStart().startsWith(BOT_PREFIX)
const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])
export function textBlocks(node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  const found: Y.XmlElement[] = []
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (TEXT_BLOCKS.has(child.nodeName)) found.push(child)
    else found.push(...textBlocks(child))
  }
  return found
}

const siblingAfter = (block: Y.XmlElement): unknown => {
  const parent = block.parent
  if (!(parent instanceof Y.XmlElement || parent instanceof Y.XmlFragment)) return undefined
  const all = parent.toArray()
  return all[all.indexOf(block) + 1]
}

const itemKey = (element: Y.AbstractType<any>): string => {
  const id = element._item?.id
  return id ? `${id.client}:${id.clock}` : 'unattached'
}

export function createBots({ hocuspocus, demo, log, reserveAwareness, releaseAwareness }: BotDeps): Bots {
  const sessions = new Map<string, Session>()
  let closing = false
  function later(session: Session, ms: number, work: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      session.timers.delete(timer)
      if (!session.stopped) work()
    }, ms)
    session.timers.add(timer)
    return timer
  }

  function enqueue(session: Session, work: () => Promise<void>) {
    session.queue = session.queue
      .then(() => (session.stopped ? undefined : work()))
      .catch((error) => log.warn({ err: error, doc: session.docName }, 'bot step failed'))
  }

  async function start(session: Session, previous: Session | undefined) {
    if (previous?.stopping) await previous.stopping
    if (session.stopped || closing) return
    const direct = await hocuspocus.openDirectConnection(session.docName, BOT_CONTEXT as never)
    if (session.stopped || closing) {
      await direct.disconnect()
      return
    }
    const document = direct.document
    if (!document) return
    session.direct = direct
    session.document = document
    reserveAwareness(session.docName, document.clientID)
    document.awareness.setLocalState({ user: { name: DEMO_BOT.name, color: DEMO_BOT.color } })

    session.onUpdate = (_update, origin) => {
      if ((origin as { context?: unknown } | null)?.context === BOT_CONTEXT) return
      scheduleCheck(session)
    }
    document.on('update', session.onUpdate)
    const alreadyGreeted = plainText(document.getXmlFragment(PAGE_TEXT_FIELD)).includes(BOT_PREFIX)
    if (!alreadyGreeted) later(session, GREETING_DELAY_MS, () => enqueue(session, () => say(session, GREETING)))
    scheduleCheck(session)
  }

  function scheduleCheck(session: Session) {
    if (session.checkTimer) {
      clearTimeout(session.checkTimer)
      session.timers.delete(session.checkTimer)
    }
    session.checkTimer = later(session, demo.botReplyDelayMs, () => {
      session.checkTimer = null
      enqueue(session, () => answerCommands(session))
    })
  }
  async function answerCommands(session: Session) {
    const document = session.document
    if (!document) return
    const fragment = document.getXmlFragment(PAGE_TEXT_FIELD)
    const blocks = textBlocks(fragment)
    for (let index = 0; index < blocks.length - 1; index += 1) {
      const block = blocks[index]
      if (block.nodeName !== 'paragraph') continue
      const text = plainText(block).replace(/\s+/g, ' ').trim()
      const match = COMMAND_RE.exec(text)
      if (!match) continue
      const key = itemKey(block)
      if (!session.handled.has(key) && isBotLine(siblingAfter(block))) {
        session.handled.set(key, text)
        continue
      }
      if (session.handled.get(key) === text) continue
      session.handled.set(key, text)
      if (session.stopped) return
      if (session.replies >= demo.botMaxReplies) {
        if (session.replies === demo.botMaxReplies) {
          session.replies += 1
          await say(session, `${BOT_PREFIX} That is all the answers I have for this page.`, block)
        }
        continue
      }
      session.replies += 1
      const filled = blocks.filter((item) => plainText(item).trim() !== '')
      const words = plainText(fragment).split(/\s+/).filter(Boolean).length
      await say(session, replyFor((match[1] ?? 'help').toLowerCase(), { paragraphs: filled.length, words }), block)
    }
  }

  async function say(session: Session, text: string, after?: Y.XmlElement) {
    const { direct, document } = session
    if (!direct || !document || session.stopped) return
    const fragment = document.getXmlFragment(PAGE_TEXT_FIELD)
    let typed!: Y.XmlText
    await direct.transact(() => {
      const paragraph = new Y.XmlElement('paragraph')
      typed = new Y.XmlText()
      const home = after && !after._item?.deleted ? after.parent : null
      const where = home instanceof Y.XmlElement || home instanceof Y.XmlFragment ? home : fragment
      const found = home && after ? where.toArray().indexOf(after) : -1
      where.insert(found >= 0 ? found + 1 : where.length, [paragraph])
      paragraph.insert(0, [typed])
    })
    for (const letter of Array.from(text)) {
      await sleep(demo.botTypeDelayMs)
      if (session.stopped || typed._item?.deleted) return
      await direct.transact(() => typed.insert(typed.length, letter))
      moveCursor(session, typed)
    }
  }

  function moveCursor(session: Session, text: Y.XmlText) {
    const awareness = session.document?.awareness
    if (!awareness) return
    const place = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length))
    awareness.setLocalState({ user: { name: DEMO_BOT.name, color: DEMO_BOT.color }, cursor: { anchor: place, head: place } })
  }

  async function stop(session: Session): Promise<void> {
    if (session.stopping) return session.stopping
    session.stopped = true
    for (const timer of session.timers) clearTimeout(timer)
    session.timers.clear()
    if (session.lingerTimer) clearTimeout(session.lingerTimer)
    if (sessions.get(session.docName) === session) sessions.delete(session.docName)
    session.stopping = (async () => {
      await session.starting.catch(() => undefined)
      await session.queue.catch(() => undefined)
      const { direct, document } = session
      if (document) {
        if (session.onUpdate) document.off('update', session.onUpdate)
        document.awareness.setLocalState(null)
        releaseAwareness(session.docName, document.clientID)
      }
      try {
        await direct?.disconnect()
      } catch (error) {
        log.warn({ err: error, doc: session.docName }, 'bot could not leave cleanly')
      }
    })()
    return session.stopping
  }

  return {
    humanJoined(docName) {
      if (closing) return
      const existing = sessions.get(docName)
      if (existing && !existing.stopped) {
        if (existing.lingerTimer) {
          clearTimeout(existing.lingerTimer)
          existing.lingerTimer = null
        }
        return
      }
      const session: Session = {
        docName,
        direct: null,
        document: null,
        stopped: false,
        starting: Promise.resolve(),
        stopping: null,
        timers: new Set(),
        queue: Promise.resolve(),
        handled: new Map(),
        replies: 0,
        checkTimer: null,
        lingerTimer: null,
        onUpdate: null,
      }
      sessions.set(docName, session)
      session.starting = start(session, existing).catch((error) => log.warn({ err: error, doc: docName }, 'bot could not start'))
    },
    humanLeft(docName, remaining) {
      const session = sessions.get(docName)
      if (!session || remaining > 0 || session.lingerTimer) return
      session.lingerTimer = setTimeout(() => void stop(session), LINGER_MS)
      session.lingerTimer.unref()
    },
    stats: () => ({ sessions: sessions.size }),
    async close() {
      closing = true
      await Promise.all([...sessions.values()].map((session) => stop(session)))
    },
  }
}
