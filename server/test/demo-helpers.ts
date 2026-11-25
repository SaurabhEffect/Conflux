import { PAGE_TEXT_FIELD, demoDocName, type DemoState } from '@conflux/shared'
import { count, eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { sandboxDocs, sandboxPages, sandboxParticipants, sandboxes } from '../src/db/schema'
import { plainText } from '../src/sync/bot'
import { Client, openDoc, type Peer, type TestServer } from './helpers'

export async function beginDemo(server: TestServer, from: Client = new Client(server)): Promise<string> {
  const reply = await from.post('/api/demo/sessions', {})
  if (reply.status !== 201) throw new Error(`could not start a demo: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply.body.ticket as string
}

export type Visitor = { client: Client; state: DemoState }

export async function visit(server: TestServer, ticket: string, client: Client = new Client(server)): Promise<Visitor> {
  const reply = await client.post('/api/demo/join', { ticket })
  if (reply.status !== 200) throw new Error(`could not join the demo: ${reply.status} ${JSON.stringify(reply.body)}`)
  return { client, state: reply.body as DemoState }
}
export async function makeDemo(server: TestServer) {
  const ticket = await beginDemo(server)
  const host = await visit(server, ticket)
  return { ticket, host }
}

export const joinAs = (server: TestServer, ticket: string) => visit(server, ticket)
export const pageIdOf = (visitor: Visitor, index = 0) => visitor.state.pages[index].id
export function openDemoDoc(server: TestServer, visitor: Visitor, pageId: string): Peer {
  const doc = demoDocName(pageId)
  return openDoc(server, visitor.client, doc, {
    token: async () => (await visitor.client.post('/api/demo/sync-token', { doc })).body?.token ?? '',
  })
}

export const fragmentOf = (peer: Peer) => peer.doc.getXmlFragment(PAGE_TEXT_FIELD)
export const demoText = (peer: Peer) => plainText(fragmentOf(peer))

export const blocksOf = (peer: Peer) =>
  fragmentOf(peer)
    .toArray()
    .map((block) => (block instanceof Y.XmlElement ? plainText(block) : ''))

export function addParagraph(peer: Peer, text: string, at?: number) {
  const fragment = fragmentOf(peer)
  peer.doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    fragment.insert(at ?? fragment.length, [paragraph])
  })
}

export async function rowsOfDemo(server: TestServer, sandboxId: string) {
  const [demos] = await server.db.select({ n: count() }).from(sandboxes).where(eq(sandboxes.id, sandboxId))
  const [people] = await server.db.select({ n: count() }).from(sandboxParticipants).where(eq(sandboxParticipants.sandboxId, sandboxId))
  const pages = await server.db.select({ id: sandboxPages.id }).from(sandboxPages).where(eq(sandboxPages.sandboxId, sandboxId))
  let docs = 0
  for (const page of pages) {
    const [row] = await server.db.select({ n: count() }).from(sandboxDocs).where(eq(sandboxDocs.pageId, page.id))
    docs += row.n
  }
  return { demos: demos.n, people: people.n, pages: pages.length, docs }
}

export async function sandboxIdOf(server: TestServer, visitor: Visitor): Promise<string> {
  const [row] = await server.db
    .select({ sandboxId: sandboxParticipants.sandboxId })
    .from(sandboxParticipants)
    .where(eq(sandboxParticipants.id, visitor.state.me.id))
  if (!row) throw new Error('this visitor is not in any demo')
  return row.sandboxId
}

export async function savedDemoText(server: TestServer, pageId: string): Promise<string | null> {
  const [row] = await server.db.select({ state: sandboxDocs.state }).from(sandboxDocs).where(eq(sandboxDocs.pageId, pageId))
  if (!row) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, row.state)
  return plainText(doc.getXmlFragment(PAGE_TEXT_FIELD))
}
