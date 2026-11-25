import { DEMO_BOT, LIMITS, type DemoState } from '@conflux/shared'
import { and, asc, count, eq, gt, lte, or, sql } from 'drizzle-orm'
import { hashToken, newToken } from '../auth/sessions'
import type { Config } from '../config'
import type { Db, Tx } from '../db/client'
import { sandboxDocs, sandboxPages, sandboxParticipants, sandboxes } from '../db/schema'
import { HttpError } from '../http/errors'
import { buildDemoPages } from './content'
import { guestColor, guestName } from './names'

export type DemoConfig = Config['demo']
export type Sandbox = typeof sandboxes.$inferSelect
export type Participant = typeof sandboxParticipants.$inferSelect

export const isAlive = (demo: DemoConfig) =>
  and(gt(sandboxes.expiresAt, sql`now()`), gt(sandboxes.lastActiveAt, sql`now() - (${demo.idleSeconds}::int * interval '1 second')`))!

const ended = () => new HttpError(404, 'demo_ended', 'This demo has ended, or the link is not valid.')
const lockCreation = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('conflux-demo-create'))`)
export async function createSandbox(db: Db, demo: DemoConfig): Promise<{ ticket: string }> {
  const ticket = newToken()
  await db.transaction(async (tx) => {
    await lockCreation(tx)
    const [alive] = await tx.select({ n: count() }).from(sandboxes).where(isAlive(demo))
    if (alive.n >= demo.maxActive) throw new HttpError(503, 'demo_full', 'Lots of people are trying the demo right now. Please try again in a few minutes.', { 'Retry-After': '60' })
    const [sandbox] = await tx
      .insert(sandboxes)
      .values({ ticketHash: hashToken(ticket), expiresAt: new Date(Date.now() + demo.maxSeconds * 1000) })
      .returning({ id: sandboxes.id })
    for (const page of buildDemoPages()) {
      const [row] = await tx
        .insert(sandboxPages)
        .values({ sandboxId: sandbox.id, title: page.title, position: page.position })
        .returning({ id: sandboxPages.id })
      await tx.insert(sandboxDocs).values({ pageId: row.id, state: page.state })
    }
  })
  return { ticket }
}

export type Joined = { participant: Participant; sandbox: Sandbox; token: string | null }
export async function joinSandbox(db: Db, demo: DemoConfig, ticket: string, currentToken: string | undefined): Promise<Joined> {
  return db.transaction(async (tx) => {
    const [sandbox] = await tx
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.ticketHash, hashToken(ticket)), isAlive(demo)))
      .for('update')
    if (!sandbox) throw ended()

    if (currentToken) {
      const [known] = await tx
        .select()
        .from(sandboxParticipants)
        .where(and(eq(sandboxParticipants.tokenHash, hashToken(currentToken)), eq(sandboxParticipants.sandboxId, sandbox.id)))
      if (known) {
        await tx.update(sandboxes).set({ lastActiveAt: sql`now()` }).where(eq(sandboxes.id, sandbox.id))
        return { participant: known, sandbox, token: null }
      }
    }

    const present = await tx.select().from(sandboxParticipants).where(eq(sandboxParticipants.sandboxId, sandbox.id))
    if (present.length >= LIMITS.demoMaxParticipants) {
      throw new HttpError(409, 'demo_full', `This demo already has ${LIMITS.demoMaxParticipants} people in it.`)
    }
    const token = newToken()
    const [participant] = await tx
      .insert(sandboxParticipants)
      .values({
        sandboxId: sandbox.id,
        tokenHash: hashToken(token),
        displayName: guestName(new Set(present.map((row) => row.displayName))),
        cursorColor: guestColor(new Set(present.map((row) => row.cursorColor))),
        isHost: present.length === 0,
      })
      .returning()
    await tx.update(sandboxes).set({ lastActiveAt: sql`now()` }).where(eq(sandboxes.id, sandbox.id))
    return { participant, sandbox, token }
  })
}

export type GuestLookup =
  | { status: 'ok'; participant: Participant; sandbox: Sandbox }
  | { status: 'ended' }
  | { status: 'unknown' }

export async function findParticipant(db: Db | Tx, demo: DemoConfig, token: string): Promise<GuestLookup> {
  if (token.length < 20 || token.length > 100) return { status: 'unknown' }
  const [row] = await db
    .select({ participant: sandboxParticipants, sandbox: sandboxes, alive: sql<boolean>`(${isAlive(demo)})` })
    .from(sandboxParticipants)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxParticipants.sandboxId))
    .where(eq(sandboxParticipants.tokenHash, hashToken(token)))
  if (!row) return { status: 'unknown' }
  return row.alive ? { status: 'ok', participant: row.participant, sandbox: row.sandbox } : { status: 'ended' }
}

export const touchIntervalMs = (demo: DemoConfig) => Math.max(100, Math.min(10_000, Math.floor(demo.idleSeconds * 250)))
export async function touchSandbox(db: Db, demo: DemoConfig, sandboxId: string): Promise<void> {
  await db
    .update(sandboxes)
    .set({ lastActiveAt: sql`now()` })
    .where(and(eq(sandboxes.id, sandboxId), sql`${sandboxes.lastActiveAt} < now() - (${touchIntervalMs(demo)}::int * interval '1 millisecond')`))
}

export async function endSandbox(db: Db, sandboxId: string): Promise<void> {
  await db.delete(sandboxes).where(eq(sandboxes.id, sandboxId))
}

export async function leaveSandbox(db: Db, participantId: string): Promise<void> {
  await db.delete(sandboxParticipants).where(eq(sandboxParticipants.id, participantId))
}

export async function purgeSandboxes(db: Db, demo: DemoConfig): Promise<number> {
  const gone = await db
    .delete(sandboxes)
    .where(or(lte(sandboxes.expiresAt, sql`now()`), lte(sandboxes.lastActiveAt, sql`now() - (${demo.idleSeconds}::int * interval '1 second')`)))
    .returning({ id: sandboxes.id })
  return gone.length
}

export async function demoState(db: Db | Tx, participant: Participant, sandbox: Sandbox, demo: DemoConfig): Promise<DemoState> {
  const [pages, [people]] = await Promise.all([
    db
      .select({ id: sandboxPages.id, title: sandboxPages.title, position: sandboxPages.position })
      .from(sandboxPages)
      .where(eq(sandboxPages.sandboxId, sandbox.id))
      .orderBy(asc(sandboxPages.position)),
    db.select({ n: count() }).from(sandboxParticipants).where(eq(sandboxParticipants.sandboxId, sandbox.id)),
  ])
  return {
    me: { id: participant.id, displayName: participant.displayName, cursorColor: participant.cursorColor, isHost: participant.isHost },
    pages,
    endsAt: sandbox.expiresAt.toISOString(),
    idleSeconds: demo.idleSeconds,
    participants: people.n,
    bot: { name: DEMO_BOT.name, color: DEMO_BOT.color },
  }
}

export type DemoDocAccess = { sandboxId: string; pageId: string; displayName: string; cursorColor: string }

export async function demoDocAccess(db: Db | Tx, demo: DemoConfig, participantId: string, sandboxId: string, pageId: string): Promise<DemoDocAccess | null> {
  const [row] = await db
    .select({ sandboxId: sandboxes.id, pageId: sandboxPages.id, displayName: sandboxParticipants.displayName, cursorColor: sandboxParticipants.cursorColor })
    .from(sandboxParticipants)
    .innerJoin(sandboxes, eq(sandboxes.id, sandboxParticipants.sandboxId))
    .innerJoin(sandboxPages, eq(sandboxPages.sandboxId, sandboxes.id))
    .where(and(eq(sandboxParticipants.id, participantId), eq(sandboxes.id, sandboxId), eq(sandboxPages.id, pageId), isAlive(demo)))
  return row ?? null
}
