import { and, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { deleteExpiredSessions } from './auth/sessions'
import type { Config } from './config'
import type { Db } from './db/client'
import { invites, pages } from './db/schema'
import { purgeSandboxes } from './demo/sandboxes'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

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

export async function purgeDemos(db: Db, demo: Config['demo'], log: FastifyBaseLogger): Promise<number> {
  try {
    const removed = await purgeSandboxes(db, demo)
    if (removed > 0) log.info({ demos: removed }, 'removed timed-out demos')
    return removed
  } catch (error) {
    log.error({ err: error }, 'removing timed-out demos failed')
    return 0
  }
}

export function startMaintenance(db: Db, log: FastifyBaseLogger, demo: Config['demo']): () => void {
  void runMaintenance(db, log)
  const hourly = setInterval(() => void runMaintenance(db, log), HOUR)
  hourly.unref()
  void purgeDemos(db, demo, log)
  const minutely = setInterval(() => void purgeDemos(db, demo, log), MINUTE)
  minutely.unref()
  return () => {
    clearInterval(hourly)
    clearInterval(minutely)
  }
}
