import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'

export type SessionUser = typeof users.$inferSelect
export type AuthContext = { sessionId: string; user: SessionUser; renewedUntil: Date | null }
const DAY = 24 * 60 * 60 * 1000
const REFRESH_AFTER = 60 * 60 * 1000
export const SESSION_MAX_DAYS = 90
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')
export async function createSession(db: Db, userId: string, days: number) {
  const token = newToken()
  const expiresAt = new Date(Date.now() + days * DAY)
  const [row] = await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt }).returning({ id: sessions.id })
  return { token, id: row.id, expiresAt }
}

export async function findSession(db: Db, token: string, days: number): Promise<AuthContext | null> {
  if (token.length < 20 || token.length > 100) return null
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)))
  if (!row) return null
  let renewedUntil: Date | null = null
  if (Date.now() - row.session.lastSeenAt.getTime() > REFRESH_AFTER) {
    renewedUntil = new Date(Math.min(Date.now() + days * DAY, row.session.createdAt.getTime() + SESSION_MAX_DAYS * DAY))
    await db.update(sessions).set({ lastSeenAt: sql`now()`, expiresAt: renewedUntil }).where(eq(sessions.id, row.session.id))
  }
  return { sessionId: row.session.id, user: row.user, renewedUntil }
}

export async function deleteSession(db: Db, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId))
}

export async function deleteSessionByToken(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

export async function deleteExpiredSessions(db: Db): Promise<number> {
  const gone = await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`)).returning({ id: sessions.id })
  return gone.length
}
