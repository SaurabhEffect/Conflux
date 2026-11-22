import { and, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { deleteExpiredSessions } from './auth/sessions'
import type { Db } from './db/client'
import { invites, pages } from './db/schema'

const HOUR = 60 * 60 * 1000
export async function runMaintenance(db: Db, log: FastifyBaseLogger): Promise<void> {
  try {
    const sessions = await deleteExpiredSessions(db)
    const oldInvites = await db
      .delete(invites)
      .where(
        or(
          lt(invites.expiresAt, sql`now() - interval '7 days'`),
          and(isNotNull(invites.revokedAt), lt(invites.revokedAt, sql`now() - interval '7 days'`)),
        ),
      )
      .returning({ id: invites.id })
    const oldPages = await db
      .delete(pages)
      .where(and(isNotNull(pages.deletedAt), lt(pages.deletedAt, sql`now() - interval '30 days'`)))
      .returning({ id: pages.id })
    if (sessions + oldInvites.length + oldPages.length > 0) {
      log.info({ sessions, invites: oldInvites.length, pages: oldPages.length }, 'maintenance removed old rows')
    }
  } catch (error) {
    log.error({ err: error }, 'maintenance failed')
  }
}

export function startMaintenance(db: Db, log: FastifyBaseLogger): () => void {
  void runMaintenance(db, log)
  const timer = setInterval(() => void runMaintenance(db, log), HOUR)
  timer.unref()
  return () => clearInterval(timer)
}
